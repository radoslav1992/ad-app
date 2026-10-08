"""Private, bounded FFmpeg renderer. Only the Worker (through the container binding) can reach this port.

The payloads and the HTTP API are described in shared/render.ts:
  POST   /jobs              JSON payload (at most 2 MB) -> 202 {status: running} | 200 {status} (known id) | 429 {status: busy}
  GET    /jobs/:id          -> {status, duration?, error?, files?, meta?}
  GET    /jobs/:id/file/:n  -> the n-th output file (video/mp4 or image/jpeg)
  DELETE /jobs/:id          -> forgets the job (stops it if running)
Operations: 'compose' (segments + voice + music + burned ASS -> MP4, optional JPEG cover), 'stills' (one JPEG per
slide), 'inspect' (what an uploaded file is) and 'audio' (an upload's sound as small MP3 parts for speech recognition).
One job runs at a time; inputs are downloaded only from SOURCE_ORIGIN.
"""
import json, math, os, re, shutil, struct, subprocess, tempfile, threading, time, urllib.error, urllib.request
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from xml.sax.saxutils import escape, quoteattr

JOBS = {}
LOCK = threading.Lock()
OPERATIONS = ('compose', 'stills', 'inspect', 'audio')
MAX_BODY = 2 * 1024 * 1024          # bytes of a POST /jobs payload
MAX_BYTES = 500 * 1024 * 1024       # bytes of one downloaded input
MAX_SIDE = 4096                     # pixels on either side of an input picture
MAX_VIDEO_PIXELS = 9_000_000        # pixels of one input video frame
MAX_LENGTH = 600                    # seconds of an input (video or audio)
MAX_OUTPUT = 180                    # seconds of a composed video
MAX_URLS = 32
MAX_SEGMENTS = 20
MAX_SLIDES = 10
MAX_DUCK_RANGES = 500
FPS = 30
RATE = 48000
SAMPLES_PER_FRAME = RATE // FPS     # 1600: segment sound is cut on the same grid as its frames
FRAME_SIZES = ((1080, 1920), (720, 1280))
FINISHED_TTL = 1800                 # seconds a finished job's files wait for the Worker
DOWNLOAD_DEADLINE = 600
FADE_IN, FADE_OUT = 1.0, 1.5        # music fades (seconds)
DUCK, DUCK_RAMP = 0.7, 0.3          # music is lowered by 70% under speech, with 0.3 s ramps
SPEECH_RATE = 16000                 # speech recognition hears mono 16 kHz
SPEECH_PART = (10, 180, 120)        # seconds per audio part: least, most, default (the Worker asks for its size)
MAX_SPEECH_PART = 2 * 1024 * 1024   # bytes of one MP3 part (32 kbit/s: about 1 MB for 180 s)
SILENCE = 0.003                     # peak below this share of full scale (about -50 dBFS): nothing to hear
# The caption fonts (renderer/fonts, the same files the browser preview uses); libass loads them before system fonts.
FONTS_DIR = os.environ.get('FONTS_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts'))
CURRENT = threading.local()  # the job this worker thread processes, so a cancel can stop its FFmpeg

INPUT_PATH = re.compile(r'/api/(render-inputs/[a-f0-9-]{36}/[0-9]{1,2}|upload-inputs/[a-f0-9-]{36})')
INPUT_QUERY = re.compile(r'token=[A-Za-z0-9._~-]{1,512}')
COLOR = re.compile(r'#[0-9a-fA-F]{6}')
VIDEO_CONTAINERS = {'mov', 'mp4', 'matroska', 'webm'}
AUDIO_CONTAINERS = {'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'}
IMAGE_FORMATS = {'jpeg_pipe', 'png_pipe', 'webp_pipe', 'image2'}  # downloads have no file extension: *_pipe
IMAGE_CODECS = {'mjpeg', 'png', 'webp'}

# Machine-readable AI marking (EU AI Act Art. 50(2)) for synthetic output: MP4 container tags plus an XMP packet with
# the IPTC digital source type (MP4: a top-level 'uuid' box; JPEG: an APP1 segment).
PRODUCT_NAME = os.environ.get('PRODUCT_NAME') or 'Hookstreak'
SOURCE_TYPE = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'
AI_COMMENT = f'AI-generated (synthetic media) - {PRODUCT_NAME}'
AI_DESCRIPTION = f'AI-generated synthetic media made with {PRODUCT_NAME}. IPTC digital source type: {SOURCE_TYPE}'
AI_XMP = ('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
          '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
          '<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"'
          ' xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"'
          f' Iptc4xmpExt:DigitalSourceType="{SOURCE_TYPE}" xmp:CreatorTool={quoteattr(PRODUCT_NAME)}>'
          f'<dc:description><rdf:Alt><rdf:li xml:lang="x-default">{escape(AI_COMMENT)}</rdf:li></rdf:Alt></dc:description>'
          '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="r"?>')
AI_TAGS = ['-metadata', f'comment={AI_COMMENT}', '-metadata', f'description={AI_DESCRIPTION}']
XMP_UUID = bytes.fromhex('be7acfcb97a942e89c71999491e3afac')
XMP_NAMESPACE = b'http://ns.adobe.com/xap/1.0/\x00'

def log(message):
    print(message, flush=True)

def synthetic(payload):
    """Whether the output holds AI-generated picture or sound (the Worker decides; a payload without the flag is)."""
    value = payload.get('synthetic', True)
    if not isinstance(value, bool): raise ValueError('Invalid synthetic flag')
    return value

def ai_tags(payload):
    return AI_TAGS if synthetic(payload) else []

def mark_ai(path):
    """Appends the XMP packet as a top-level 'uuid' box (the MP4 place for XMP). It follows the media data, so no
    sample offset moves; FFmpeg's +faststart has already put the index first."""
    xmp = AI_XMP.encode('utf-8')
    with open(path, 'ab') as f: f.write(struct.pack('>I', 24 + len(xmp)) + b'uuid' + XMP_UUID + xmp)

def mark_jpeg(path):
    """Inserts the XMP packet as an APP1 segment right after SOI, or after the JFIF APP0 segment that must come first."""
    with open(path, 'rb') as f: data = f.read()
    if data[:2] != b'\xff\xd8': raise ValueError('Media processing failed: not a JPEG')
    at = 2
    if data[2:4] == b'\xff\xe0': at = 4 + struct.unpack('>H', data[4:6])[0]
    body = XMP_NAMESPACE + AI_XMP.encode('utf-8')
    segment = b'\xff\xe1' + struct.pack('>H', 2 + len(body)) + body
    with open(path, 'wb') as f: f.write(data[:at] + segment + data[at:])

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Download redirect refused')

def cancelled():
    job = getattr(CURRENT, 'job', None)
    return bool(job and job.get('cancelled'))

def command(args, timeout=90):
    """Runs FFmpeg/ffprobe with a deadline; a cancel (DELETE) kills it. Returns its standard output."""
    job = getattr(CURRENT, 'job', None)
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if job is not None:
        job['proc'] = p
        if job.get('cancelled'): p.kill()
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill(); p.communicate()
        raise ValueError('Media processing timed out')
    finally:
        if job is not None: job.pop('proc', None)
    if p.returncode or cancelled():
        if p.returncode and not cancelled():
            log(f'{os.path.basename(args[0])} exited with {p.returncode}: {err.decode("utf-8", "replace").strip()[-600:]}')
        raise ValueError('Media processing failed')
    return out

def filter_path(path):
    """A path placed inside a filter graph: anything but plain path characters would change the graph."""
    if not re.fullmatch(r'[\w/.+-]+', path): raise ValueError('Media processing failed: unsafe path')
    return path

MOTION_ZOOM = 0.12  # as shared/layers.ts
MOTIONS = ('zoom-in', 'zoom-out', 'pan-left', 'pan-right')

def motion_filter(motion, width, height, seconds):
    """Slow movement over a still image ("Ken Burns"), as motionAt in shared/layers.ts: the picture is cropped
    to the frame (at twice its size, so the window moves smoothly), then a window of 1/zoom of it is shown, linearly
    from the segment's start (on = 0) to its end (on = frames - 1)."""
    if motion not in MOTIONS: raise ValueError('Invalid motion')
    frames = max(2, int(round(seconds * 30)))
    p, z = f'on/{frames - 1}', MOTION_ZOOM
    zoom = {'zoom-in': f'1+{z}*{p}', 'zoom-out': f'{1 + z}-{z}*{p}'}.get(motion, f'{1 + z}')
    x = {'pan-left': f'(iw-iw/zoom)*(1-{p})', 'pan-right': f'(iw-iw/zoom)*{p}'}.get(motion, '(iw-iw/zoom)/2')
    return (f'scale={2 * width}:{2 * height}:force_original_aspect_ratio=increase,crop={2 * width}:{2 * height},setsar=1,'
            f"zoompan=z='{zoom}':x='{x}':y='(ih-ih/zoom)/2':d={frames}:s={width}x{height}:fps=30")

def cover_filter(width, height):
    """Fills the frame; the overflow is cropped, centred."""
    return f'scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1'

def fit(graph, source, label, mode, width, height, blur):
    """Puts the picture `source` into a width x height frame and returns the result's label. "cover" fills the frame;
    "contain" shows the whole picture, centred over a blurred, darkened, cover-cropped copy of itself. The copy is
    blurred at the small size `blur` (cheap, and smoother), then scaled up; darkening scales luma and chroma alike."""
    if mode != 'contain':
        graph.append(f'{source}{cover_filter(width, height)}[{label}]')
        return f'[{label}]'
    bw, bh = blur
    graph.append(f'{source}split=2[{label}a][{label}b]')
    graph.append(f'[{label}a]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},format=yuv420p,'
                 f'boxblur={max(2, bw // 12)}:2,scale={width}:{height},setsar=1,'
                 f'lutyuv=y=16+(val-16)*0.6:u=128+(val-128)*0.6:v=128+(val-128)*0.6[{label}c]')
    graph.append(f'[{label}b]scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[{label}d]')
    graph.append(f'[{label}c][{label}d]overlay=(W-w)/2:(H-h)/2,format=yuv420p[{label}]')
    return f'[{label}]'

def burn(ass_path):
    """The libass filter for captions and on-screen text, with the bundled fonts."""
    return f'ass=filename={filter_path(ass_path)}:fontsdir={filter_path(FONTS_DIR)}'

def write_ass(job, name, text):
    """Writes ASS for the burn step; None when there is nothing to burn."""
    if not text.strip(): return None
    path = os.path.join(job['dir'], name)
    with open(path, 'w', encoding='utf-8', errors='replace') as f: f.write(text)
    return path

def input_url(url, origin):
    """Inputs come only from short-lived capability URLs on this site (SOURCE_ORIGIN), on the two input paths."""
    if not isinstance(url, str) or len(url) > 2048 or not re.fullmatch(r'[\x21-\x7e]+', url): raise ValueError('Invalid input URL')
    if not origin: raise ValueError('Download refused: SOURCE_ORIGIN is not set')
    parsed = urlparse(url)
    if (f'{parsed.scheme}://{parsed.netloc}' != origin or not INPUT_PATH.fullmatch(parsed.path) or parsed.params
            or parsed.fragment or '#' in url or (parsed.query and not INPUT_QUERY.fullmatch(parsed.query))):
        raise ValueError('Invalid input URL')
    return url

def download(url, path):
    deadline = time.time() + DOWNLOAD_DEADLINE
    # Never through a proxy from the environment, never following a redirect.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    with opener.open(url, timeout=90) as response, open(path, 'wb') as out:
        length = response.headers.get('Content-Length') or ''
        if length.isdigit() and int(length) > MAX_BYTES: raise ValueError('Input file too large')
        total = 0
        while True:
            # The socket timeout is per read; the whole download also has a deadline, and stops on cancel.
            if cancelled(): raise ValueError('Download stopped')
            if time.time() > deadline: raise ValueError('Download timed out')
            chunk = response.read(1024 * 1024)
            if not chunk: break
            total += len(chunk)
            if total > MAX_BYTES: raise ValueError('Input file too large')
            out.write(chunk)

def fetch(job, urls, used):
    """Downloads the inputs the payload uses to input<i> in the job's directory. The same URL listed twice is
    downloaded once (hard link)."""
    files, fetched = {}, {}
    for i in sorted(used):
        path = os.path.join(job['dir'], f'input{i}')
        if urls[i] in fetched: os.link(fetched[urls[i]], path)
        else: download(urls[i], path); fetched[urls[i]] = path
        files[i] = path
    return files

def probe(path):
    return json.loads(command(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json',path]))

def seconds(value):
    try: s = float(value)
    except (TypeError, ValueError): return 0.0
    return s if math.isfinite(s) and s > 0 else 0.0

def media_duration(path, info):
    """Length in seconds: from the container, else its streams, else the end of the last packet. A WebM written as a
    stream (browser and many screen recordings) stores no length at all."""
    duration = seconds(info.get('format', {}).get('duration'))
    if not duration: duration = max([seconds(s.get('duration')) for s in info.get('streams', [])] + [0.0])
    if not duration:
        packets = command(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-show_entries','packet=pts_time,duration_time',
                           '-of','csv=p=0',path], timeout=180)
        for line in packets.decode('utf-8', 'replace').splitlines():
            fields = line.split(',')
            duration = max(duration, seconds(fields[0]) + (seconds(fields[1]) if len(fields) > 1 else 0))
    return duration

def display_size(video):
    """Width and height as the picture is shown: FFmpeg turns a phone video recorded on its side upright when decoding."""
    w, h = int(video.get('width') or 0), int(video.get('height') or 0)
    rotation = next((d['rotation'] for d in video.get('side_data_list') or [] if 'rotation' in d), None)
    try: rotation = int(float(rotation if rotation is not None else (video.get('tags') or {}).get('rotate', 0)))
    except (TypeError, ValueError): rotation = 0
    return (h, w) if rotation % 180 == 90 else (w, h)

def decodes(path, stream):
    """Proves that the first picture (stream 'v') or the first second of sound ('a') really decodes."""
    if stream == 'v': args, expect = ['-map','0:v:0','-frames:v','1','-vf','scale=16:16,format=gray','-f','rawvideo'], 256
    else: args, expect = ['-map','0:a:0','-t','1','-ac','1','-ar','8000','-f','s16le'], 2
    try: out = command(['ffmpeg','-nostdin','-v','error','-threads','1','-protocol_whitelist','file,pipe','-i',path,*args,'pipe:1'], timeout=120)
    except ValueError as e:
        if 'timed out' in str(e): raise
        out = b''
    if len(out) < expect: raise ValueError('Unsupported format: no decodable stream')

def classify(path):
    """What a downloaded file is: {kind: video|audio|image, width, height, hasAudio, duration} (`picture` adds the
    length of a video's picture stream). Refuses what renders cannot use safely: unknown containers and codecs, pictures
    too large to decode cheaply (image headers can declare enormous sizes in a tiny file), media longer than 10 minutes."""
    try: info = probe(path)
    except ValueError as e:
        if 'timed out' in str(e): raise
        raise ValueError('Unsupported format')
    formats = set(str((info.get('format') or {}).get('format_name') or '').split(','))
    streams = info.get('streams') or []
    pictures = [s for s in streams if s.get('codec_type') == 'video' and s.get('codec_name') and not (s.get('disposition') or {}).get('attached_pic')]
    sounds = [s for s in streams if s.get('codec_type') == 'audio' and s.get('codec_name')]
    width = height = 0
    if pictures:
        width, height = int(pictures[0].get('width') or 0), int(pictures[0].get('height') or 0)
        if width <= 0 or height <= 0: raise ValueError('Unsupported format: no picture size')
    if pictures and formats & IMAGE_FORMATS:
        if pictures[0]['codec_name'] not in IMAGE_CODECS: raise ValueError('Unsupported image format')
        if width > MAX_SIDE or height > MAX_SIDE: raise ValueError('Input resolution too large')
        decodes(path, 'v')
        return {'kind': 'image', 'width': width, 'height': height, 'hasAudio': False, 'duration': 0.0, 'picture': 0.0}
    if pictures:
        if not formats & VIDEO_CONTAINERS: raise ValueError('Unsupported video container')
        if width > MAX_SIDE or height > MAX_SIDE or width * height > MAX_VIDEO_PIXELS: raise ValueError('Input resolution too large')
        kind = 'video'
    elif sounds:
        if not formats & AUDIO_CONTAINERS: raise ValueError('Unsupported audio container')
        kind = 'audio'
    else:
        raise ValueError('Unsupported format: no picture or sound')
    duration = media_duration(path, info)
    if duration <= 0: raise ValueError('Unsupported format: no length')
    if duration > MAX_LENGTH: raise ValueError('Media too long')
    decodes(path, 'v' if kind == 'video' else 'a')
    if kind == 'video': width, height = display_size(pictures[0])
    picture = min(duration, seconds(pictures[0].get('duration')) or duration) if kind == 'video' else 0.0
    return {'kind': kind, 'width': width, 'height': height, 'hasAudio': bool(sounds), 'duration': duration, 'picture': picture}

def number(value, low, high):
    """A JSON number within [low, high]; anything else (text, booleans, NaN) is refused before it reaches a filter."""
    if isinstance(value, bool) or not isinstance(value, (int, float)): raise ValueError('Invalid number')
    try: value = float(value)
    except OverflowError: raise ValueError('Invalid number')
    if not math.isfinite(value) or value < low or value > high: raise ValueError('Invalid number')
    return value

def index(value, count):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < count: raise ValueError('Invalid input index')
    return value

def color(value):
    if not isinstance(value, str) or not COLOR.fullmatch(value): raise ValueError('Invalid color')
    return value[1:].lower()

def frame_size(payload):
    size = (payload.get('width'), payload.get('height'))
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in size) or size not in FRAME_SIZES:
        raise ValueError('Invalid frame size')
    return int(size[0]), int(size[1])

def input_urls(payload, origin):
    urls = payload.get('urls', [])
    if not isinstance(urls, list) or len(urls) > MAX_URLS: raise ValueError('Invalid urls')
    return [input_url(url, origin) for url in urls]

def text(value):
    if not isinstance(value, str): raise ValueError('Invalid ass')
    return value

def merge_ranges(ranges, length):
    """Speech ranges for ducking, clipped to the video, sorted and merged where they overlap or lie closer than their
    two ramps: then the ramps never overlap and their terms can be summed."""
    merged = []
    for a, b in sorted((max(0.0, a), min(length, b)) for a, b in ranges):
        if b <= a: continue
        if merged and a - merged[-1][1] < 2 * DUCK_RAMP: merged[-1][1] = max(merged[-1][1], b)
        else: merged.append([a, b])
    return merged

def music_gain(volume, ranges, length):
    """FFmpeg volume expression for the music: its volume, a fade-in and a fade-out, lowered under speech (merged
    ranges) with ramps that reach the full ducking at the range's edges."""
    gain = f'{volume:.4f}*clip(min(t/{FADE_IN},({length:.3f}-t)/{FADE_OUT}),0,1)'
    if ranges:
        r = DUCK_RAMP
        terms = '+'.join(f'clip(min((t-{a - r:.3f})/{r},({b + r:.3f}-t)/{r}),0,1)' for a, b in ranges)
        gain += f'*(1-{DUCK}*clip({terms},0,1))'
    return gain

def segment_plan(s, count):
    if not isinstance(s, dict): raise ValueError('Invalid segment')
    # Durations are snapped to the frame grid, so picture and sound of every segment have exactly the same length.
    frames = int(round(number(s.get('duration'), 0.5, 120) * FPS))
    mode = s.get('fit') if s.get('fit') is not None else 'cover'
    if mode not in ('cover', 'contain'): raise ValueError('Invalid fit')
    motion = s.get('motion')
    if motion is not None and motion not in MOTIONS: raise ValueError('Invalid motion')
    trim = number(s['trim'], 0, MAX_LENGTH) if s.get('trim') is not None else 0.0
    audio = number(s['audio'], 0, 1) if s.get('audio') is not None else 0.0
    kind = s.get('kind')
    if kind == 'color': return {'kind': kind, 'color': color(s.get('color')), 'frames': frames}
    if kind not in ('image', 'video'): raise ValueError('Invalid segment kind')
    # Fields that do not apply to the kind are checked above but ignored.
    return {'kind': kind, 'input': index(s.get('input'), count), 'frames': frames, 'fit': mode,
            'motion': motion if kind == 'image' else None, 'trim': trim if kind == 'video' else 0.0,
            'audio': audio if kind == 'video' else 0.0}

def compose_plan(payload, origin):
    """Validates a compose payload completely, before anything is downloaded."""
    width, height = frame_size(payload)
    urls = input_urls(payload, origin)
    segments = payload['segments']
    if not isinstance(segments, list) or not 1 <= len(segments) <= MAX_SEGMENTS: raise ValueError('Invalid segments')
    segments = [segment_plan(s, len(urls)) for s in segments]
    frames = sum(s['frames'] for s in segments)
    if frames > MAX_OUTPUT * FPS: raise ValueError('Video too long')
    voice, music = payload.get('voice'), payload.get('music')
    if voice is not None:
        voice = {'input': index(voice['input'], len(urls)), 'start': number(voice['start'], 0, MAX_OUTPUT),
                 'volume': number(voice['volume'], 0, 1)}
    if music is not None:
        duck = music.get('duck') if music.get('duck') is not None else []
        if not isinstance(duck, list) or len(duck) > MAX_DUCK_RANGES: raise ValueError('Invalid duck ranges')
        ranges = []
        for pair in duck:
            if not isinstance(pair, list) or len(pair) != 2: raise ValueError('Invalid duck range')
            a, b = number(pair[0], 0, 3600), number(pair[1], 0, 3600)
            if b < a: raise ValueError('Invalid duck range')
            ranges.append((a, b))
        music = {'input': index(music['input'], len(urls)), 'volume': number(music['volume'], 0, 1),
                 'duck': merge_ranges(ranges, frames / FPS)}
    overlay = payload.get('overlay')
    if overlay is not None: overlay = overlay_plan(overlay, len(urls), width, frames)
    cover = payload.get('coverAt')
    used = {s['input'] for s in segments if 'input' in s} | {x['input'] for x in (voice, music, overlay) if x}
    return {'width': width, 'height': height, 'urls': urls, 'used': used, 'segments': segments, 'frames': frames,
            'voice': voice, 'music': music, 'overlay': overlay, 'ass': text(payload['ass']), 'synthetic': synthetic(payload),
            'cover': None if cover is None else number(cover, 0, 3600)}

def overlay_plan(o, count, width, total_frames):
    """A green-screen clip keyed over the segments. Its times are on the output clock, snapped to frames; it ends
    with the video at the latest."""
    start = int(round(number(o['start'], 0, MAX_OUTPUT) * FPS))
    end = min(total_frames, int(round(number(o['end'], 0, MAX_OUTPUT) * FPS)))
    if end <= start: raise ValueError('Invalid overlay time')
    def option(name, low, high, default):
        return number(o[name], low, high) if o.get(name) is not None else default
    return {'input': index(o['input'], count), 'start': start, 'frames': end - start, 'chroma': color(o['chroma']),
            'similarity': option('similarity', 0.01, 0.6, 0.3), 'blend': option('blend', 0, 0.5, 0.1),
            'width': int(round(number(o['width'], 0.2, 1) * width / 2)) * 2,
            'x': number(o['x'], 0, 1), 'y': number(o['y'], 0, 1), 'audio': option('audio', 0, 1, 0.0)}

def stills_plan(payload, origin):
    """Validates a stills payload completely, before anything is downloaded."""
    width, height = frame_size(payload)
    urls = input_urls(payload, origin)
    slides = payload['slides']
    if not isinstance(slides, list) or not 1 <= len(slides) <= MAX_SLIDES: raise ValueError('Invalid slides')
    plan = []
    for s in slides:
        if not isinstance(s, dict): raise ValueError('Invalid slide')
        if (s.get('input') is None) == (s.get('color') is None): raise ValueError('Invalid slide: needs an input or a color')
        plan.append({'ass': text(s['ass']), 'input': None if s.get('input') is None else index(s['input'], len(urls)),
                     'color': None if s.get('color') is None else color(s['color'])})
    return {'width': width, 'height': height, 'urls': urls, 'slides': plan, 'synthetic': synthetic(payload),
            'used': {s['input'] for s in plan if s['input'] is not None}}

def checked(build, *args):
    """Runs a payload check; a missing field or a value of the wrong shape is an invalid payload."""
    try: return build(*args)
    except (KeyError, TypeError, AttributeError, IndexError): raise ValueError('Invalid payload')

def compose(job, payload, origin):
    """Segments joined with hard cuts, an optional green-screen clip keyed over them, captions burned over everything;
    the segments' own sound (or silence), the overlay's sound, a voice track and looped, faded and ducked music mixed.
    Output 0: MP4; output 1 (with coverAt): a JPEG of it."""
    plan = checked(compose_plan, payload, origin)
    width, height, total_frames = plan['width'], plan['height'], plan['frames']
    total, total_samples = total_frames / FPS, total_frames * SAMPLES_PER_FRAME
    files = fetch(job, plan['urls'], plan['used'])
    media = {i: classify(path) for i, path in files.items()}
    inputs, graph, pairs = [], [], ''
    def add_input(*args):
        inputs.append(['-threads', '1', *args])
        return len(inputs) - 1
    blur = (width // 4, height // 4)
    for i, s in enumerate(plan['segments']):
        n, has_sound = s['frames'], False
        length = n / FPS
        if s['kind'] == 'color':
            graph.append(f'color=c=0x{s["color"]}:s={width}x{height}:r={FPS},trim=end_frame={n},setsar=1,format=yuv420p[v{i}]')
        elif s['kind'] == 'image':
            if media[s['input']]['kind'] != 'image': raise ValueError('Unsupported image input')
            k = add_input('-i', files[s['input']])
            if s['motion']:
                # "contain" is composed at twice the size first; the movement then runs over the composed frame.
                picture = (fit(graph, f'[{k}:v:0]', f'f{i}', 'contain', 2 * width, 2 * height, blur)
                           if s['fit'] == 'contain' else f'[{k}:v:0]')
                graph.append(f'{picture}{motion_filter(s["motion"], width, height, length)},setsar=1,format=yuv420p,'
                             f'trim=end_frame={n},setpts=N/{FPS}/TB[v{i}]')
            else:
                # The single picture is framed once, then repeated.
                picture = fit(graph, f'[{k}:v:0]', f'f{i}', s['fit'], width, height, blur)
                graph.append(f'{picture}format=yuv420p,loop=loop={n - 1}:size=1,settb=1/{FPS},setpts=N,fps={FPS},'
                             f'trim=end_frame={n}[v{i}]')
        else:
            source = media[s['input']]
            if source['kind'] != 'video': raise ValueError('Unsupported video input')
            if s['trim'] > source['picture'] - 0.1: raise ValueError('Invalid trim: after the end of the video')
            seek = ['-ss', f'{s["trim"]:.3f}'] if s['trim'] else []
            k = add_input(*seek, '-t', f'{length + 0.5:.3f}', '-i', files[s['input']])
            graph.append(f'[{k}:v:0]setpts=PTS-STARTPTS,fps={FPS}[p{i}]')
            picture = fit(graph, f'[p{i}]', f'f{i}', s['fit'], width, height, blur)
            # A source shorter than the segment holds its last frame.
            graph.append(f'{picture}format=yuv420p,tpad=stop_mode=clone:stop_duration={length:.3f},trim=end_frame={n},'
                         f'setpts=N/{FPS}/TB[v{i}]')
            if s['audio'] > 0 and source['hasAudio']:
                graph.append(f'[{k}:a:0]aresample={RATE}:async=1:first_pts=0,aformat=sample_rates={RATE}:channel_layouts=stereo,'
                             f'volume={s["audio"]:.4f},apad,atrim=end_sample={n * SAMPLES_PER_FRAME}[a{i}]')
                has_sound = True
        if not has_sound:
            graph.append(f'anullsrc=r={RATE}:cl=stereo,atrim=end_sample={n * SAMPLES_PER_FRAME}[a{i}]')
        pairs += f'[v{i}][a{i}]'
    graph.append(f'{pairs}concat=n={len(plan["segments"])}:v=1:a=1[vcat][acat]')
    video, sounds = '[vcat]', ['[acat]']
    overlay = plan['overlay']
    if overlay:
        source = media[overlay['input']]
        if source['kind'] != 'video': raise ValueError('Unsupported overlay input')
        # Looped by the demuxer if shorter than its time on screen; keyed at its own size, then scaled (alpha kept)
        # and moved to its start on the output clock. Placement: x/y 0 = left/top edge on the frame's, 1 = right/bottom.
        k = add_input('-stream_loop', '-1', '-i', files[overlay['input']])
        n, start = overlay['frames'], overlay['start']
        graph.append(f'[{k}:v:0]setpts=PTS-STARTPTS,fps={FPS},trim=end_frame={n},format=yuva420p,'
                     f'chromakey=color=0x{overlay["chroma"]}:similarity={overlay["similarity"]:.4f}:blend={overlay["blend"]:.4f},'
                     f'scale={overlay["width"]}:-2,setsar=1,setpts=(N+{start})/{FPS}/TB[ovv]')
        graph.append(f'[vcat][ovv]overlay=x=(W-w)*{overlay["x"]:.4f}:y=(H-h)*{overlay["y"]:.4f}:eof_action=pass,format=yuv420p[vov]')
        video = '[vov]'
        if overlay['audio'] > 0 and source['hasAudio']:
            graph.append(f'[{k}:a:0]aresample={RATE}:async=1:first_pts=0,aformat=sample_rates={RATE}:channel_layouts=stereo,'
                         f'atrim=end_sample={n * SAMPLES_PER_FRAME},volume={overlay["audio"]:.4f},'
                         f'adelay=delays={start * SAMPLES_PER_FRAME}S:all=1,apad,atrim=end_sample={total_samples}[ovsound]')
            sounds.append('[ovsound]')
    ass = write_ass(job, 'captions.ass', plan['ass'])
    if ass:
        # Captions and on-screen text above everything else.
        graph.append(f'{video}{burn(ass)},format=yuv420p[vout]')
        video = '[vout]'
    voice, music = plan['voice'], plan['music']
    if voice:
        if not media[voice['input']]['hasAudio']: raise ValueError('Voice has no audio')
        k = add_input('-i', files[voice['input']])
        graph.append(f'[{k}:a:0]aresample={RATE}:async=1:first_pts=0,aformat=sample_rates={RATE}:channel_layouts=stereo,'
                     f'volume={voice["volume"]:.4f},adelay=delays={int(round(voice["start"] * 1000))}:all=1,'
                     f'apad,atrim=end_sample={total_samples}[voice]')
        sounds.append('[voice]')
    if music:
        if not media[music['input']]['hasAudio']: raise ValueError('Music has no audio')
        # Looped to the whole video by the demuxer; timestamps then count samples, so `t` is the output clock.
        k = add_input('-stream_loop', '-1', '-i', files[music['input']])
        graph.append(f'[{k}:a:0]aformat=sample_rates={RATE}:channel_layouts=stereo,asetpts=N/SR/TB,atrim=end_sample={total_samples},'
                     f"volume='{music_gain(music['volume'], music['duck'], total)}':eval=frame[music]")
        sounds.append('[music]')
    audio = '[acat]'
    if len(sounds) > 1:
        graph.append(f'{"".join(sounds)}amix=inputs={len(sounds)}:duration=first:normalize=0[aout]')
        audio = '[aout]'
    output = os.path.join(job['dir'], 'output0.mp4')
    command(['ffmpeg','-nostdin','-v','error','-filter_complex_threads','1','-protocol_whitelist','file,pipe',
             *[a for i in inputs for a in i],'-filter_complex',';'.join(graph),'-map',video,'-map',audio,
             '-c:v','libx264','-preset','veryfast','-crf','23','-maxrate','4M','-bufsize','8M','-threads','1','-pix_fmt','yuv420p',
             '-r',str(FPS),'-c:a','aac','-b:a','160k','-ar',str(RATE),'-ac','2','-t',f'{total:.3f}',
             *ai_tags(payload),'-movflags','+faststart',output], timeout=3000)
    if plan['synthetic']: mark_ai(output)
    outputs = [output]
    if plan['cover'] is not None:
        # A frame of the finished video (captions included), the requested second clamped inside the video.
        at = min(plan['cover'], max(0.0, total - 0.1))
        cover = os.path.join(job['dir'], 'output1.jpg')
        command(['ffmpeg','-nostdin','-v','error','-threads','1','-protocol_whitelist','file,pipe','-ss',f'{at:.3f}','-i',output,
                 '-frames:v','1','-q:v','3','-update','1',cover], timeout=120)
        if not os.path.exists(cover) or not os.path.getsize(cover): raise ValueError('Media processing failed: no cover')
        if plan['synthetic']: mark_jpeg(cover)
        outputs.append(cover)
    job.update(status='completed', duration=round(total, 3), files=len(outputs), outputs=outputs)

def stills(job, payload, origin):
    """One JPEG per slide: the picture cover-cropped to the frame (or a solid colour), its ASS burned in."""
    plan = checked(stills_plan, payload, origin)
    width, height = plan['width'], plan['height']
    files = fetch(job, plan['urls'], plan['used'])
    media = {i: classify(path) for i, path in files.items()}
    outputs = []
    for n, slide in enumerate(plan['slides']):
        ass = write_ass(job, f'slide{n}.ass', slide['ass'])
        captions = f',{burn(ass)}' if ass else ''
        if slide['color']:
            source, graph = [], f'color=c=0x{slide["color"]}:s={width}x{height}:r=1:d=1,setsar=1{captions}[v]'
        else:
            if media[slide['input']]['kind'] != 'image': raise ValueError('Unsupported image input')
            source, graph = ['-threads','1','-i',files[slide['input']]], f'[0:v:0]{cover_filter(width, height)}{captions}[v]'
        output = os.path.join(job['dir'], f'output{n}.jpg')
        command(['ffmpeg','-nostdin','-v','error','-filter_complex_threads','1','-protocol_whitelist','file,pipe',*source,
                 '-filter_complex',graph,'-map','[v]','-frames:v','1','-q:v','3','-update','1',output], timeout=120)
        if not os.path.exists(output) or not os.path.getsize(output): raise ValueError('Media processing failed: no still')
        if plan['synthetic']: mark_jpeg(output)
        outputs.append(output)
    job.update(status='completed', files=len(outputs), outputs=outputs)

def inspect(job, payload, origin):
    """What an uploaded file is: kind, picture size (as shown), whether it has sound, and its length (0 for images)."""
    url = input_url(payload.get('url'), origin)
    source = os.path.join(job['dir'], 'input0')
    download(url, source)
    media = classify(source)
    job.update(status='completed', duration=round(media['duration'], 3), files=0, outputs=[],
               meta={k: media[k] for k in ('kind', 'width', 'height', 'hasAudio')})

def audio_plan(payload, origin):
    """Validates an audio payload completely, before anything is downloaded."""
    url = input_url(payload.get('url'), origin)
    low, high, default = SPEECH_PART
    part = number(payload['part'], low, high) if payload.get('part') is not None else float(default)
    return {'url': url, 'part': part}

def wav_samples(path):
    """The samples of a 16-bit PCM WAV that FFmpeg wrote (its 'data' chunk follows the format and any LIST chunk)."""
    with open(path, 'rb') as f: data = f.read()
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE': raise ValueError('Media processing failed: not a WAV')
    at = 12
    while at + 8 <= len(data):
        name, size = data[at:at + 4], struct.unpack('<I', data[at + 4:at + 8])[0]
        if name == b'data':
            size = min(size, len(data) - at - 8) // 2 * 2
            return memoryview(data)[at + 8:at + 8 + size].cast('h')
        at += 8 + size + (size & 1)
    raise ValueError('Media processing failed: no sound data')

def extract_audio(job, payload, origin):
    """The sound of an upload for speech recognition: mono 16 kHz MP3 parts of `part` seconds (output n starts at
    n * part seconds), at most 10 minutes in all. A file without sound fails (MEDIA_NO_AUDIO); a silent one has no
    parts. `duration` is the length of the sound."""
    plan = checked(audio_plan, payload, origin)
    source = os.path.join(job['dir'], 'input0')
    download(plan['url'], source)
    media = classify(source)
    if media['kind'] == 'image' or not media['hasAudio']: raise ValueError('Input has no audio')
    wav = os.path.join(job['dir'], 'speech.wav')
    command(['ffmpeg','-nostdin','-v','error','-threads','1','-protocol_whitelist','file,pipe','-i',source,'-map','0:a:0','-vn',
             '-ac','1','-ar',str(SPEECH_RATE),'-t',str(MAX_LENGTH),'-c:a','pcm_s16le','-f','wav',wav], timeout=600)
    samples = wav_samples(wav)
    total = len(samples) / SPEECH_RATE
    loudest = max(max(samples), -min(samples)) / 32768 if len(samples) else 0.0
    samples.release()
    outputs = []
    if loudest >= SILENCE:
        # Cut from the decoded WAV, so each part starts exactly at n * part seconds.
        for n in range(int(math.ceil(total / plan['part']))):
            start = n * plan['part']
            length = min(plan['part'], total - start)
            if length < 0.3: break
            output = os.path.join(job['dir'], f'output{n}.mp3')
            command(['ffmpeg','-nostdin','-v','error','-threads','1','-protocol_whitelist','file,pipe','-ss',f'{start:.3f}','-t',f'{length:.3f}',
                     '-i',wav,'-ac','1','-ar',str(SPEECH_RATE),'-c:a','libmp3lame','-b:a','32k','-f','mp3',output], timeout=300)
            if not os.path.getsize(output): raise ValueError('Media processing failed: no audio part')
            if os.path.getsize(output) > MAX_SPEECH_PART: raise ValueError('Output too large')
            outputs.append(output)
    job.update(status='completed', duration=round(total, 3), files=len(outputs), outputs=outputs)

def failure_code(e):
    """A short reason the Worker can explain to the user (never the raw message)."""
    m = str(e).lower()
    if isinstance(e, (subprocess.TimeoutExpired, TimeoutError)) or 'timed out' in m: return 'MEDIA_TIMEOUT'
    if isinstance(e, (OSError, HTTPException)): return 'MEDIA_INPUT'  # urllib errors, refused connections, broken reads
    if 'invalid' in m: return 'MEDIA_INVALID'
    if 'resolution' in m or 'too large' in m: return 'MEDIA_TOO_LARGE'
    if 'no audio' in m: return 'MEDIA_NO_AUDIO'
    if 'unsupported' in m: return 'MEDIA_FORMAT'
    if 'too long' in m: return 'MEDIA_TOO_LONG'
    if 'download' in m: return 'MEDIA_INPUT'
    return 'MEDIA_PROCESSING_FAILED'

def process(job, payload, id=None):
    CURRENT.job = job
    operation = payload.get('operation')
    try:
        origin = (os.environ.get('SOURCE_ORIGIN') or '').rstrip('/')
        if operation == 'compose': compose(job, payload, origin)
        elif operation == 'stills': stills(job, payload, origin)
        elif operation == 'inspect': inspect(job, payload, origin)
        elif operation == 'audio': extract_audio(job, payload, origin)
        else: raise ValueError('Invalid operation')
    except Exception as e:
        job.update(status='failed', error=failure_code(e))
        if not job.get('cancelled'): log(f'{operation} {id or ""} failed ({job["error"]}): {type(e).__name__}: {e}')
    finally:
        job['finished'] = time.time()
        CURRENT.job = None
        if job.get('cancelled'):
            # Stopped by the Worker (timeout or failure): nothing to keep, and the slot is free at once.
            job.update(status='failed', error='MEDIA_CANCELLED')
            shutil.rmtree(job['dir'], ignore_errors=True)
            with LOCK:
                if JOBS.get(id) is job: del JOBS[id]
            return
        # Only the outputs stay (until the Worker deletes the job or it is reclaimed): inputs, ASS files and the
        # leftovers of a failed render go now.
        keep = set(job.get('outputs') or []) if job.get('status') == 'completed' else set()
        for name in os.listdir(job['dir']):
            path = os.path.join(job['dir'], name)
            if path not in keep: os.remove(path)

STATUS_FIELDS = ('status', 'duration', 'error', 'files', 'meta')
CONTENT_TYPES = {'.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg'}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def respond(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def route(self):
        """['jobs', id] or ['jobs', id, 'file', n], or None."""
        parts = urlparse(self.path).path.split('/')[1:]
        return parts if len(parts) in (2, 4) and parts[0] == 'jobs' else None

    def do_POST(self):
        if urlparse(self.path).path != '/jobs': return self.respond(404, {})
        try: size = int(self.headers.get('Content-Length', '0'))
        except ValueError: size = 0
        if size <= 0: return self.respond(400, {})
        if size > MAX_BODY: return self.respond(413, {})
        try: payload = json.loads(self.rfile.read(size))
        except (ValueError, RecursionError): return self.respond(400, {})
        id = payload.get('id') if isinstance(payload, dict) else None
        if not isinstance(id, str) or not re.fullmatch(r'[a-f0-9-]{36}', id) or payload.get('operation') not in OPERATIONS:
            return self.respond(400, {})
        with LOCK:
            # Finished jobs the Worker never collected are reclaimed after 30 minutes.
            for key, old in list(JOBS.items()):
                if old.get('finished', time.time()) < time.time() - FINISHED_TTL:
                    shutil.rmtree(old['dir'], ignore_errors=True); del JOBS[key]
            if id in JOBS: return self.respond(200, {'status': JOBS[id]['status']})
            if any(j['status'] == 'running' for j in JOBS.values()): return self.respond(429, {'status': 'busy'})
            job = {'status': 'running', 'dir': tempfile.mkdtemp(prefix='render-')}
            JOBS[id] = job
            threading.Thread(target=process, args=(job, payload, id), daemon=True).start()
        return self.respond(202, {'status': 'running'})

    def do_GET(self):
        parts = self.route()
        job = JOBS.get(parts[1]) if parts else None
        if not job: return self.respond(404, {})
        if len(parts) == 2: return self.respond(200, {k: job[k] for k in STATUS_FIELDS if k in job})
        outputs = job.get('outputs') or []
        if parts[2] != 'file' or not re.fullmatch(r'[0-9]{1,3}', parts[3]) or job.get('status') != 'completed' or int(parts[3]) >= len(outputs):
            return self.respond(404, {})
        path = outputs[int(parts[3])]
        try: f = open(path, 'rb')
        except OSError: return self.respond(404, {})
        with f:
            self.send_response(200)
            self.send_header('Content-Type', CONTENT_TYPES.get(os.path.splitext(path)[1], 'application/octet-stream'))
            self.send_header('Content-Length', str(os.fstat(f.fileno()).st_size))
            self.end_headers()
            shutil.copyfileobj(f, self.wfile, 1024 * 1024)

    def do_DELETE(self):
        parts = self.route()
        if not parts or len(parts) != 2: return self.respond(404, {})
        with LOCK:
            job = JOBS.get(parts[1])
            if job and job['status'] != 'running': shutil.rmtree(job['dir'], ignore_errors=True); del JOBS[parts[1]]
            elif job:
                # A running job is stopped: its FFmpeg is killed and the thread cleans up when it returns.
                job['cancelled'] = True
                proc = job.get('proc')
                if proc:
                    try: proc.kill()
                    except OSError: pass
        return self.respond(200, {})

if __name__ == '__main__':
    if not os.environ.get('SOURCE_ORIGIN'): log('SOURCE_ORIGIN is not set: every input download is refused')
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
