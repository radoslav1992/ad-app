"""Run with `python3 tests/renderer_test.py` from the repository root; needs ffmpeg and ffprobe (as in renderer/Dockerfile).

The renderer's functions run in this process. Its inputs come from a local HTTP server that stands in for the site
(SOURCE_ORIGIN), on the capability paths the Worker hands out (/api/render-inputs/<job>/<n>, /api/upload-inputs/<id>).
"""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True  # no __pycache__ in renderer/, the container's build context
sys.path.insert(0, str(ROOT / 'renderer'))
spec = importlib.util.spec_from_file_location('server', ROOT / 'renderer' / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

AI_SOURCE_TYPE = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'
JOB = '0f0e0d0c-0b0a-4908-8706-050403020100'
TOKEN = 'Tk3n.abc_DEF-123~'
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))
FIXTURES = None  # the fixture site, started once for all tests
WORK = None

def make(name, *args):
    path = FIXTURES.dir / name
    subprocess.run(['ffmpeg','-nostdin','-v','error','-y',*args,str(path)], check=True)
    return path

class Site:
    """Serves fixture files on the input paths and counts the requests (path and query) it gets."""
    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix='renderer-fixtures-'))
        self.names, self.requests = [], []
        site = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                site.requests.append(self.path)
                path = self.path.split('?', 1)[0]
                if path == f'/api/render-inputs/{JOB}/98':
                    self.send_response(302); self.send_header('Location', site.url('photo.jpg')); self.end_headers(); return
                m = re.fullmatch(rf'/api/render-inputs/{JOB}/([0-9]+)|/api/upload-inputs/([a-f0-9-]+)', path)
                name = None
                if m and m.group(1) and int(m.group(1)) < len(site.names): name = site.names[int(m.group(1))]
                if m and m.group(2): name = next((n for n in site.names if site.upload_id(n) == m.group(2)), None)
                if not name: self.send_response(404); self.send_header('Content-Length', '0'); self.end_headers(); return
                data = (site.dir / name).read_bytes()
                self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.origin = f'http://127.0.0.1:{self.httpd.server_address[1]}'

    def url(self, name):
        if name not in self.names: self.names.append(name)
        return f'{self.origin}/api/render-inputs/{JOB}/{self.names.index(name)}?token={TOKEN}'

    def upload_id(self, name):
        if name not in self.names: self.names.append(name)
        return f'aaaaaaaa-bbbb-4ccc-8ddd-{self.names.index(name):012x}'

    def upload_url(self, name):
        return f'{self.origin}/api/upload-inputs/{self.upload_id(name)}'

def setUpModule():
    global FIXTURES, WORK
    FIXTURES = Site()
    WORK = Path(tempfile.mkdtemp(prefix='renderer-work-'))
    os.environ['SOURCE_ORIGIN'] = FIXTURES.origin
    os.environ.pop('PRODUCT_NAME', None)
    server.log = lambda message: None  # expected failures would fill the output
    # Pictures: wider than 9:16 with red | blue halves, plain colours, one far too large.
    make('wide.png', '-f','lavfi','-i','color=c=red:s=1280x720','-vf','drawbox=x=640:y=0:w=640:h=720:color=blue:t=fill','-frames:v','1')
    make('lime.png', '-f','lavfi','-i','color=c=lime:s=640x360','-frames:v','1')
    make('photo.jpg', '-f','lavfi','-i','color=c=orange:s=800x600','-frames:v','1')
    make('tall.png', '-f','lavfi','-i','color=c=purple:s=600x1200','-frames:v','1')
    make('photo.webp', '-f','lavfi','-i','color=c=yellow:s=320x240','-frames:v','1')
    make('huge.png', '-f','lavfi','-i','color=c=white:s=5000x16','-frames:v','1')
    make('anim.gif', '-f','lavfi','-i','testsrc=s=64x64:r=5:d=0.4')
    # Videos: red 640x360 with sound, blue 640x360 without, a green screen with a moving test box and sound.
    make('clip.mp4', '-f','lavfi','-i','color=c=red:s=640x360:r=30:d=2','-f','lavfi','-i','sine=frequency=440:duration=2',
         '-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-shortest')
    make('mute.mp4', '-f','lavfi','-i','color=c=blue:s=640x360:r=30:d=1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p')
    make('green.mp4', '-f','lavfi','-i','color=c=0x00ff00:s=640x360:r=30:d=2','-f','lavfi','-i','testsrc=s=160x120:r=30:d=2',
         '-f','lavfi','-i','sine=frequency=600:duration=2','-filter_complex',"[0][1]overlay=x='t*200':y=120[v]",'-map','[v]','-map','2:a',
         '-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-shortest')
    make('big.mp4', '-f','lavfi','-i','color=c=gray:s=4096x2304:r=30:d=0.1','-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p')
    # A WebM written as a stream (as browsers and screen recorders do) stores no length.
    with open(FIXTURES.dir / 'recorded.webm', 'wb') as out:
        subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=320x180:d=2','-f','lavfi','-i','sine=duration=2',
                        '-c:v','libvpx','-deadline','realtime','-c:a','libopus','-f','webm','-'], stdout=out, check=True)
    # Sound.
    make('voice.wav', '-f','lavfi','-i','sine=frequency=330:duration=1.5')
    make('music.wav', '-f','lavfi','-i','sine=frequency=220:duration=1')
    make('song.mp3', '-f','lavfi','-i','sine=frequency=500:duration=1')
    make('song.m4a', '-f','lavfi','-i','sine=frequency=500:duration=1','-c:a','aac')
    make('long.wav', '-f','lavfi','-i','anullsrc=r=8000:cl=mono','-t','601','-c:a','pcm_u8')
    (FIXTURES.dir / 'broken.bin').write_bytes(b'not a media file at all ' * 200)

def tearDownModule():
    FIXTURES.httpd.shutdown()
    shutil.rmtree(FIXTURES.dir, ignore_errors=True)
    shutil.rmtree(WORK, ignore_errors=True)

def run(payload):
    """Runs one job the way the HTTP handler does (in this thread) and returns its record."""
    job = {'dir': tempfile.mkdtemp(dir=WORK), 'status': 'running'}
    server.process(job, {'id': JOB, **payload}, JOB)
    return job

def ass(width, height, *events):
    """ASS with a style whose opaque box is red (BorderStyle 3: the outline colour fills the box)."""
    return ('[Script Info]\nScriptType: v4.00+\n'
            f'PlayResX: {width}\nPlayResY: {height}\n\n[V4+ Styles]\n'
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, '
            'StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
            f'Style: Box,Noto Sans,{height // 25},&H00FFFFFF,&H00FFFFFF,&H000000FF,&H00000000,-1,0,0,0,100,100,0,0,3,{height // 25},0,5,0,0,0,1\n\n'
            '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
            + ''.join(f'Dialogue: 0,0:00:00.00,0:01:00.00,Box,,0,0,0,,{{\\pos({x},{y})}}{words}\n' for x, y, words in events))

def ffprobe(path, *args):
    return json.loads(subprocess.check_output(['ffprobe','-v','error',*args,'-show_format','-show_streams','-of','json',str(path)]))

def frame(path, t, x, y, w=1, h=1):
    seek = ['-ss', str(t)] if t is not None else []
    raw = subprocess.check_output(['ffmpeg','-nostdin','-v','error',*seek,'-i',str(path),'-frames:v','1',
                                   '-vf',f'format=rgb24,crop={w}:{h}:{x}:{y}','-f','rawvideo','-'])
    return [tuple(raw[i:i + 3]) for i in range(0, len(raw), 3)]

def pixel(path, t, x, y):
    return frame(path, t, x, y)[0]

def near(c, want, tolerance=60):
    return all(abs(a - b) < tolerance for a, b in zip(c, want))

def share(path, t, box, want, tolerance=60):
    """Share of the pixels in box (x, y, w, h) near the colour `want`."""
    pixels = frame(path, t, *box)
    return sum(near(p, want, tolerance) for p in pixels) / len(pixels)

def loudness(path, start, length):
    """Mean volume (dB) of the sound from `start` for `length` seconds; digital silence is about -91."""
    out = subprocess.run(['ffmpeg','-nostdin','-ss',str(start),'-t',str(length),'-i',str(path),'-map','0:a:0',
                          '-af','volumedetect','-f','null','-'], capture_output=True, text=True).stderr
    return float(re.search(r'mean_volume: (-?[0-9.]+) dB', out).group(1))

def jpeg_segments(data):
    """(marker, body) of each JPEG segment before the image data."""
    assert data[:2] == b'\xff\xd8', 'SOI'
    at, out = 2, []
    while data[at] == 0xff and data[at + 1] != 0xda:
        size = struct.unpack('>H', data[at + 2:at + 4])[0]
        out.append((data[at + 1], data[at + 4:at + 2 + size]))
        at += 2 + size
    return out

class RendererTest(unittest.TestCase):
    def setUp(self):
        self.requests = len(FIXTURES.requests)

    def assert_decodes(self, path):
        decode = subprocess.run(['ffmpeg','-nostdin','-v','error','-i',str(path),'-f','null','-'], capture_output=True, text=True)
        self.assertEqual((decode.returncode, decode.stderr), (0, ''))

    def assert_ai_marked(self, path):
        """The AI marking: MP4 comment/description tags and XMP with the IPTC digital source type, as ffprobe reads
        them, the XMP box last; the file still decodes without errors."""
        tags = ffprobe(path, '-export_xmp', '1')['format']['tags']
        self.assertEqual(tags.get('comment'), 'AI-generated (synthetic media) - Hookstreak')
        self.assertIn(AI_SOURCE_TYPE, tags.get('description', ''))
        self.assertIn(f'Iptc4xmpExt:DigitalSourceType="{AI_SOURCE_TYPE}"', tags.get('xmp', ''))
        self.assertIn('xmp:CreatorTool="Hookstreak"', tags.get('xmp', ''))
        self.assert_decodes(path)
        self.assertTrue(Path(path).read_bytes().endswith(server.AI_XMP.encode('utf-8')), 'XMP box is the last top-level box')

    def assert_jpeg(self, path, width, height, marked):
        info = ffprobe(path)['streams'][0]
        self.assertEqual((info['codec_name'], info['width'], info['height']), ('mjpeg', width, height))
        self.assert_decodes(path)
        segments = jpeg_segments(Path(path).read_bytes())
        xmp = [body for marker, body in segments if marker == 0xe1 and body.startswith(server.XMP_NAMESPACE)]
        if marked:
            self.assertEqual(segments[0][0], 0xe0, 'JFIF APP0 stays first')
            self.assertEqual(xmp, [server.XMP_NAMESPACE + server.AI_XMP.encode('utf-8')])
            self.assertIn(AI_SOURCE_TYPE.encode(), xmp[0])
        else:
            self.assertEqual(xmp, [])
            self.assertNotIn(b'trainedAlgorithmicMedia', Path(path).read_bytes())

    def assert_outputs_only(self, job):
        """Inputs and ASS files are gone once the job ends; the outputs wait for the Worker."""
        self.assertEqual(sorted(os.listdir(job['dir'])), sorted(os.path.basename(p) for p in job['outputs']))

    def assert_fails(self, payload, code, network=False):
        job = run(payload)
        self.assertEqual((job['status'], job.get('error')), ('failed', code), payload)
        if not network: self.assertEqual(len(FIXTURES.requests), self.requests, 'refused before any download')
        self.assertEqual(os.listdir(job['dir']), [])
        return job

class ComposeTest(RendererTest):
    def test_slideshow_with_video_voice_ducked_music_captions_and_cover(self):
        urls = [FIXTURES.url(n) for n in ('wide.png', 'clip.mp4', 'mute.mp4', 'voice.wav', 'music.wav')]
        job = run({'operation': 'compose', 'urls': urls, 'width': 720, 'height': 1280, 'synthetic': True, 'coverAt': 99,
                   'segments': [
                       {'input': 0, 'kind': 'image', 'duration': 1.5, 'motion': 'zoom-in'},
                       # 0.5 s into a 2 s clip: 1.5 s of it, then its last frame holds for 0.5 s.
                       {'input': 1, 'kind': 'video', 'duration': 2.0, 'trim': 0.5, 'audio': 0.8},
                       {'input': 2, 'kind': 'video', 'duration': 1.0, 'fit': 'contain', 'audio': 1},
                       {'kind': 'color', 'color': '#112233', 'duration': 0.5}],
                   'voice': {'input': 3, 'start': 0.5, 'volume': 1},
                   'music': {'input': 4, 'volume': 0.4, 'duck': [[0.5, 2.0], [1.8, 3.0]]},
                   'ass': ass(720, 1280, (360, 300, 'Hi'))})
        self.assertEqual(job['status'], 'completed', job)
        self.assertEqual((job['duration'], job['files']), (5.0, 2))
        self.assert_outputs_only(job)
        mp4, cover = job['outputs']
        info = ffprobe(mp4, '-count_frames')
        video = next(s for s in info['streams'] if s['codec_type'] == 'video')
        audio = next(s for s in info['streams'] if s['codec_type'] == 'audio')
        self.assertEqual((video['codec_name'], video['width'], video['height'], video['pix_fmt'], video['r_frame_rate'], video['nb_read_frames']),
                         ('h264', 720, 1280, 'yuv420p', '30/1', '150'))
        self.assertEqual((audio['codec_name'], audio['sample_rate'], audio['channels']), ('aac', '48000', 2))
        self.assertAlmostEqual(float(info['format']['duration']), 5.0, delta=0.1)
        data = Path(mp4).read_bytes()
        self.assertLess(data.index(b'moov'), data.index(b'mdat'), 'faststart')
        self.assert_ai_marked(mp4)
        # The moving still: red | blue halves, cover-cropped around the edge in the middle.
        self.assertTrue(near(pixel(mp4, 0.2, 100, 640), (255, 0, 0)) and near(pixel(mp4, 0.2, 620, 640), (0, 0, 255)))
        # The trimmed clip, then its held last frame.
        self.assertTrue(near(pixel(mp4, 2.0, 360, 900), (255, 0, 0)))
        self.assertTrue(near(pixel(mp4, 3.3, 360, 900), (255, 0, 0)), 'last frame held')
        # "contain": the whole wide video in the middle, a darkened blurred copy above and below it.
        self.assertTrue(near(pixel(mp4, 3.8, 360, 640), (0, 0, 255)))
        self.assertTrue(near(pixel(mp4, 3.8, 360, 150), (0, 0, 153), 40), pixel(mp4, 3.8, 360, 150))
        self.assertTrue(near(pixel(mp4, 4.8, 100, 1200), (0x11, 0x22, 0x33), 20), 'colour segment')
        # Captions over every segment (Noto Sans on a red box).
        for t in (0.5, 2.5, 4.8): self.assertGreater(share(mp4, t, (310, 260, 100, 80), (255, 0, 0)), 0.3, t)
        self.assertGreater(loudness(mp4, 0, 5), -40)
        # The cover: the requested second clamped into the video (its last tenth), captions included.
        self.assert_jpeg(cover, 720, 1280, marked=True)
        self.assertTrue(near(pixel(cover, None, 100, 1200), (0x11, 0x22, 0x33), 20))
        self.assertGreater(share(cover, None, (310, 260, 100, 80), (255, 0, 0)), 0.3)

    def test_segment_sound_or_silence_and_one_download_per_url(self):
        clip = FIXTURES.url('clip.mp4')
        job = run({'operation': 'compose', 'urls': [clip, clip, FIXTURES.url('mute.mp4')], 'width': 720, 'height': 1280,
                   'synthetic': False, 'ass': '', 'segments': [
                       {'input': 0, 'kind': 'video', 'duration': 1, 'audio': 1},
                       {'input': 1, 'kind': 'video', 'duration': 1, 'trim': 1.0, 'audio': 0},
                       {'input': 2, 'kind': 'video', 'duration': 1, 'audio': 1}]})  # no sound in the file: silence
        self.assertEqual(job['status'], 'completed', job)
        self.assertEqual((job['duration'], job['files']), (3.0, 1))
        clip_path = clip.split(FIXTURES.origin, 1)[1]
        self.assertEqual(FIXTURES.requests[self.requests:].count(clip_path), 1, 'the same URL is downloaded once')
        self.assertIn(f'?token={TOKEN}', FIXTURES.requests[-1])
        mp4 = job['outputs'][0]
        self.assertGreater(loudness(mp4, 0.1, 0.8), -35)
        self.assertLess(loudness(mp4, 1.1, 0.8), -80)
        self.assertLess(loudness(mp4, 2.1, 0.8), -80)
        self.assertTrue(near(pixel(mp4, 1.5, 360, 640), (255, 0, 0)) and near(pixel(mp4, 2.5, 360, 640), (0, 0, 255)))
        # Not synthetic: no marking.
        tags = ffprobe(mp4, '-export_xmp', '1')['format'].get('tags', {})
        self.assertNotIn('comment', tags)
        self.assertNotIn(AI_SOURCE_TYPE, json.dumps(tags))
        self.assertNotIn(b'trainedAlgorithmicMedia', Path(mp4).read_bytes())

    def test_music_loops_fades_in_and_out_and_ducks_under_speech(self):
        # Overlapping and close ranges are merged, ranges are clipped to the video.
        self.assertEqual(server.merge_ranges([(1.6, 2.0), (1.9, 2.4), (3.5, 9), (4.5, 5)], 4.0), [[1.6, 2.4], [3.5, 4.0]])
        self.assertEqual(server.merge_ranges([(2.5, 3), (1, 2)], 9), [[1, 3]])
        self.assertEqual(server.merge_ranges([(1, 1.2), (2, 3)], 9), [[1, 1.2], [2, 3]])
        # A 1 s tone under a 4 s video: looped, faded in over 1 s and out over 1.5 s, ducked to 30% around 1.6-2.4 s.
        job = run({'operation': 'compose', 'urls': [FIXTURES.url('music.wav')], 'width': 720, 'height': 1280, 'synthetic': True,
                   'ass': '', 'segments': [{'kind': 'color', 'color': '#000000', 'duration': 4}],
                   'music': {'input': 0, 'volume': 1, 'duck': [[1.6, 2.0], [1.9, 2.4]]}})
        self.assertEqual(job['status'], 'completed', job)
        mp4 = job['outputs'][0]
        full, ducked = loudness(mp4, 1.0, 0.25), loudness(mp4, 1.7, 0.6)
        self.assertGreater(full, -30)
        self.assertAlmostEqual(ducked - full, -10.5, delta=1.5)  # 20 * log10(0.3)
        start, looped = loudness(mp4, 0, 0.25), loudness(mp4, 3.0, 0.25)
        self.assertLess(start, full - 10, 'fade-in')
        self.assertTrue(full - 8 < looped < full - 1, (full, looped))  # looped, fading out
        self.assertLess(loudness(mp4, 3.9, 0.08), full - 15, 'fade-out')

    def test_contain_puts_the_whole_picture_on_a_blurred_copy(self):
        lime, clip = FIXTURES.url('lime.png'), FIXTURES.url('clip.mp4')
        job = run({'operation': 'compose', 'urls': [lime, clip], 'width': 720, 'height': 1280, 'synthetic': False, 'ass': '',
                   'segments': [{'input': 0, 'kind': 'image', 'duration': 1, 'fit': 'contain'},
                                {'input': 1, 'kind': 'video', 'duration': 1, 'fit': 'contain'},
                                {'input': 0, 'kind': 'image', 'duration': 1, 'fit': 'contain', 'motion': 'zoom-out'}]})
        self.assertEqual(job['status'], 'completed', job)
        mp4 = job['outputs'][0]
        # 640x360 shown 720x405 in the middle (y 437-842); above and below, the copy darkened to 60%.
        for t, bright, dark in ((0.5, (0, 255, 0), (0, 153, 0)), (1.5, (255, 0, 0), (153, 0, 0)), (2.1, (0, 255, 0), (0, 153, 0))):
            self.assertTrue(near(pixel(mp4, t, 360, 640), bright), (t, pixel(mp4, t, 360, 640)))
            for x, y in ((360, 150), (20, 1200)):
                self.assertTrue(near(pixel(mp4, t, x, y), dark, 40), (t, x, y, pixel(mp4, t, x, y)))

    def test_green_screen_overlay_is_keyed_looped_and_placed_under_the_captions(self):
        # A 2 s green-screen clip (a test box moving right at 200 px/s) on screen from 0.5 to 3.0 s: it loops once.
        job = run({'operation': 'compose', 'urls': [FIXTURES.url('green.mp4')], 'width': 720, 'height': 1280, 'synthetic': True,
                   'segments': [{'kind': 'color', 'color': '#0000ff', 'duration': 3.5}],
                   'overlay': {'input': 0, 'start': 0.5, 'end': 3.0, 'chroma': '#00ff00', 'similarity': 0.3, 'blend': 0.1,
                               'width': 1, 'x': 0.5, 'y': 1, 'audio': 1},
                   'ass': ass(720, 1280, (600, 1200, 'Hi'))})
        self.assertEqual(job['status'], 'completed', job)
        self.assertEqual(job['duration'], 3.5)
        mp4 = job['outputs'][0]
        blue, green = (0, 0, 255), (0, 255, 0)
        # Full width (720x405), at the bottom (y 875-1280). The box: source x = 200 * clip time, y 120-240 → y 1010-1145.
        self.assertTrue(near(pixel(mp4, 0.25, 150, 1080), blue), 'not on screen before its start')
        for t, x in ((1.0, 112), (2.75, 56)):  # clip time 0.5 and, looped, 0.25
            box = (x + 10, 1020, 160, 110)
            # The test box stays (colours close to green, like its cyan and yellow bars, are partly keyed).
            self.assertLess(share(mp4, t, box, blue), 0.5, (t, 'the box is not keyed'))
            self.assertLess(share(mp4, t, box, green), 0.1, t)
            self.assertGreater(share(mp4, t, (400, 900, 100, 80), blue), 0.95, (t, 'the green is keyed out'))
        self.assertTrue(near(pixel(mp4, 3.25, 150, 1080), blue), 'gone after its end')
        # Captions are drawn over the overlay.
        self.assertGreater(share(mp4, 1.0, (560, 1170, 80, 60), (255, 0, 0)), 0.3)
        # Its sound, delayed to its start, looped with it.
        self.assertLess(loudness(mp4, 0, 0.4), -80)
        self.assertGreater(loudness(mp4, 0.6, 1.7), -35)
        self.assertGreater(loudness(mp4, 2.6, 0.3), -35)
        self.assertLess(loudness(mp4, 3.1, 0.3), -80)

class StillsTest(RendererTest):
    def test_stills_cover_crop_colour_and_captions_as_marked_jpegs(self):
        job = run({'operation': 'stills', 'width': 1080, 'height': 1920, 'synthetic': True,
                   'urls': [FIXTURES.url('photo.jpg'), FIXTURES.url('tall.png')],
                   'slides': [{'input': 0, 'ass': ass(1080, 1920, (540, 960, 'Hi'))},
                              {'color': '#336699', 'ass': ass(1080, 1920, (540, 400, 'Hi'))},
                              {'input': 1, 'ass': ''}]})
        self.assertEqual(job['status'], 'completed', job)
        self.assertEqual(job['files'], 3)
        self.assertNotIn('duration', job)
        self.assert_outputs_only(job)
        for path in job['outputs']: self.assert_jpeg(path, 1080, 1920, marked=True)
        first, second, third = job['outputs']
        self.assertTrue(near(pixel(first, None, 20, 20), (255, 165, 0)))
        self.assertGreater(share(first, None, (480, 900, 120, 120), (255, 0, 0)), 0.3)
        self.assertTrue(near(pixel(second, None, 20, 1900), (0x33, 0x66, 0x99), 20))
        self.assertGreater(share(second, None, (480, 340, 120, 120), (255, 0, 0)), 0.3)
        self.assertTrue(near(pixel(third, None, 540, 960), (128, 0, 128)))

class InspectTest(RendererTest):
    def inspect(self, url):
        return run({'operation': 'inspect', 'url': url})

    def test_inspect_reports_kind_size_sound_and_length(self):
        cases = {
            'clip.mp4': ({'kind': 'video', 'width': 640, 'height': 360, 'hasAudio': True}, 2.0),
            'mute.mp4': ({'kind': 'video', 'width': 640, 'height': 360, 'hasAudio': False}, 1.0),
            'recorded.webm': ({'kind': 'video', 'width': 320, 'height': 180, 'hasAudio': True}, 2.0),
            'song.mp3': ({'kind': 'audio', 'width': 0, 'height': 0, 'hasAudio': True}, 1.0),
            'song.m4a': ({'kind': 'audio', 'width': 0, 'height': 0, 'hasAudio': True}, 1.0),
            'voice.wav': ({'kind': 'audio', 'width': 0, 'height': 0, 'hasAudio': True}, 1.5),
            'photo.jpg': ({'kind': 'image', 'width': 800, 'height': 600, 'hasAudio': False}, 0),
            'tall.png': ({'kind': 'image', 'width': 600, 'height': 1200, 'hasAudio': False}, 0),
            'photo.webp': ({'kind': 'image', 'width': 320, 'height': 240, 'hasAudio': False}, 0),
        }
        self.assertNotIn('duration', server.probe(str(FIXTURES.dir / 'recorded.webm'))['format'])
        for name, (meta, duration) in cases.items():
            job = self.inspect(FIXTURES.upload_url(name) if name.endswith('.mp3') else FIXTURES.url(name))
            self.assertEqual(job['status'], 'completed', (name, job))
            self.assertEqual((job['meta'], job['files']), (meta, 0), name)
            self.assertAlmostEqual(job['duration'], duration, delta=0.1, msg=name)
            self.assertEqual(os.listdir(job['dir']), [], 'the input is removed')
        # A phone video recorded on its side is reported upright.
        self.assertEqual(server.display_size({'width': 1920, 'height': 1080, 'side_data_list': [{'rotation': -90}]}), (1080, 1920))
        self.assertEqual(server.display_size({'width': 1920, 'height': 1080, 'tags': {'rotate': '180'}}), (1920, 1080))

    def test_inspect_names_the_reason_for_a_rejection(self):
        for name, code in (('broken.bin', 'MEDIA_FORMAT'), ('anim.gif', 'MEDIA_FORMAT'), ('huge.png', 'MEDIA_TOO_LARGE'),
                           ('big.mp4', 'MEDIA_TOO_LARGE'), ('long.wav', 'MEDIA_TOO_LONG')):
            job = self.inspect(FIXTURES.url(name))
            self.assertEqual((job['status'], job.get('error')), ('failed', code), name)
            self.assertNotIn('meta', job)
        missing = f'{FIXTURES.origin}/api/render-inputs/{JOB}/77'
        redirect = f'{FIXTURES.origin}/api/render-inputs/{JOB}/98'
        for url in (missing, redirect):
            self.assertEqual(self.inspect(url).get('error'), 'MEDIA_INPUT', url)
        self.assertEqual(FIXTURES.requests[-1], f'/api/render-inputs/{JOB}/98', 'the redirect is not followed')

class ValidationTest(RendererTest):
    def base(self, **changes):
        payload = {'operation': 'compose', 'urls': [FIXTURES.url('photo.jpg')], 'width': 720, 'height': 1280, 'synthetic': True,
                   'ass': '', 'segments': [{'input': 0, 'kind': 'image', 'duration': 1}]}
        payload.update(changes)
        return payload

    def segment(self, **changes):
        return self.base(segments=[{'input': 0, 'kind': 'image', 'duration': 1, **changes}])

    def test_invalid_payloads_fail_before_any_download(self):
        photo = FIXTURES.url('photo.jpg')
        origin_path = photo.split(FIXTURES.origin, 1)[1]
        invalid = [
            self.segment(input=1), self.segment(input=-1), self.segment(input='0'), self.segment(input=True), self.segment(input=0.5),
            self.base(urls=['https://attacker.example' + origin_path]),
            self.base(urls=[f'{FIXTURES.origin}/api/media/{JOB}/0']),
            self.base(urls=[f'{FIXTURES.origin}/api/render-inputs/{JOB}/100']),
            self.base(urls=[f'{FIXTURES.origin}/api/render-inputs/{JOB}/0?token=x&next=/admin']),
            self.base(urls=[f'{FIXTURES.origin}/api/render-inputs/{JOB}/0#x']),
            self.base(urls=[photo.replace('http://', 'http://user@')]),
            self.base(urls=photo),
            self.base(width=4096, height=4096), self.base(width=1280, height=720), self.base(width='720'),
            self.segment(duration=0.2), self.segment(duration=121), self.segment(duration='1'), self.segment(duration=float('nan')),
            self.segment(duration=10 ** 400), self.segment(motion='spin'), self.segment(fit='stretch'), self.segment(kind='gif'),
            self.base(segments=[]), self.base(segments=[{'kind': 'color', 'color': '#00000', 'duration': 1}]),
            self.base(segments=[{'kind': 'color', 'color': '#000000\n', 'duration': 1}]),
            self.base(segments=[{'kind': 'image', 'duration': 1, 'input': 0}] * 21),
            self.base(voice={'input': 0, 'start': 0, 'volume': "1':eval=frame[x]"}),
            self.base(voice={'input': 0, 'start': -1, 'volume': 1}), self.base(voice={'input': 0, 'volume': 1}),
            self.base(music={'input': 0, 'volume': 1.5, 'duck': []}),
            self.base(music={'input': 0, 'volume': 1, 'duck': [[2, 1]]}),
            self.base(music={'input': 0, 'volume': 1, 'duck': [["0,1)+1", 2]]}),
            self.base(music={'input': 0, 'volume': 1, 'duck': [[0, 1, 2]]}),
            self.base(overlay={'input': 0, 'start': 2, 'end': 1, 'chroma': '#00ff00', 'width': 1, 'x': 0.5, 'y': 1}),
            self.base(overlay={'input': 0, 'start': 0, 'end': 1, 'chroma': 'green', 'width': 1, 'x': 0.5, 'y': 1}),
            self.base(overlay={'input': 0, 'start': 0, 'end': 1, 'chroma': '#00ff00', 'width': 0.1, 'x': 0.5, 'y': 1}),
            self.base(overlay={'input': 0, 'start': 0, 'end': 1, 'chroma': '#00ff00', 'width': 1, 'x': 0.5, 'y': 1, 'similarity': 0.9}),
            self.base(coverAt='1'), self.base(ass=None), self.base(synthetic='yes'),
            {'operation': 'stills', 'urls': [photo], 'width': 1080, 'height': 1920, 'synthetic': True,
             'slides': [{'input': 0, 'color': '#000000', 'ass': ''}]},
            {'operation': 'stills', 'urls': [photo], 'width': 1080, 'height': 1920, 'synthetic': True, 'slides': [{'ass': ''}]},
            {'operation': 'stills', 'urls': [photo], 'width': 1080, 'height': 1920, 'synthetic': True, 'slides': [{'input': 0, 'ass': ''}] * 11},
            {'operation': 'stills', 'urls': [photo], 'width': 1080, 'height': 1920, 'synthetic': True, 'slides': [{'input': 0}]},
            {'operation': 'inspect', 'url': 'https://attacker.example' + origin_path},
            {'operation': 'export', 'url': photo},
        ]
        for payload in invalid:
            self.assert_fails(payload, 'MEDIA_INVALID')
        # Longer than 180 s in total.
        self.assert_fails(self.base(segments=[{'input': 0, 'kind': 'image', 'duration': 100}] * 2), 'MEDIA_TOO_LONG')
        self.assert_fails(self.base(segments=[{'kind': 'color', 'color': '#000000', 'duration': 120}, {'kind': 'color', 'color': '#000000', 'duration': 60.1}]), 'MEDIA_TOO_LONG')
        # Without SOURCE_ORIGIN nothing is downloaded at all.
        with patch.dict(os.environ, {'SOURCE_ORIGIN': ''}):
            self.assert_fails(self.base(), 'MEDIA_INPUT')
            self.assert_fails({'operation': 'inspect', 'url': photo}, 'MEDIA_INPUT')

    def test_unusable_inputs_are_named_after_download(self):
        def urls(*names): return [FIXTURES.url(n) for n in names]
        image = lambda **s: [{'input': 0, 'kind': 'image', 'duration': 1, **s}]
        self.assert_fails(self.base(urls=urls('huge.png'), segments=image()), 'MEDIA_TOO_LARGE', network=True)
        self.assert_fails(self.base(urls=urls('clip.mp4'), segments=image()), 'MEDIA_FORMAT', network=True)
        self.assert_fails(self.base(urls=urls('photo.jpg'), segments=[{'input': 0, 'kind': 'video', 'duration': 1}]), 'MEDIA_FORMAT', network=True)
        self.assert_fails(self.base(urls=urls('broken.bin'), segments=image()), 'MEDIA_FORMAT', network=True)
        self.assert_fails(self.base(urls=urls('photo.jpg', 'mute.mp4'), voice={'input': 1, 'start': 0, 'volume': 1}), 'MEDIA_NO_AUDIO', network=True)
        self.assert_fails(self.base(music={'input': 0, 'volume': 1, 'duck': []}), 'MEDIA_NO_AUDIO', network=True)
        self.assert_fails(self.base(urls=urls('clip.mp4'), segments=[{'input': 0, 'kind': 'video', 'duration': 1, 'trim': 5}]), 'MEDIA_INVALID', network=True)
        self.assert_fails(self.base(overlay={'input': 0, 'start': 0, 'end': 1, 'chroma': '#00ff00', 'width': 1, 'x': 0.5, 'y': 1}), 'MEDIA_FORMAT', network=True)
        self.assert_fails(self.base(urls=[f'{FIXTURES.origin}/api/render-inputs/{JOB}/77']), 'MEDIA_INPUT', network=True)
        self.assert_fails({'operation': 'stills', 'urls': urls('clip.mp4'), 'width': 720, 'height': 1280, 'synthetic': False,
                           'slides': [{'input': 0, 'ass': ''}]}, 'MEDIA_FORMAT', network=True)

    def test_failure_codes_never_carry_the_message(self):
        cases = [(TimeoutError('timed out'), 'MEDIA_TIMEOUT'), (ValueError('Media processing timed out'), 'MEDIA_TIMEOUT'),
                 (urllib.error.HTTPError('u', 500, 'secret detail', {}, None), 'MEDIA_INPUT'), (ConnectionRefusedError(), 'MEDIA_INPUT'),
                 (ValueError('Download redirect refused'), 'MEDIA_INPUT'), (ValueError('Input file too large'), 'MEDIA_TOO_LARGE'),
                 (ValueError('Invalid number'), 'MEDIA_INVALID'), (ValueError('Media processing failed'), 'MEDIA_PROCESSING_FAILED'),
                 (KeyError('x'), 'MEDIA_PROCESSING_FAILED')]
        for error, code in cases: self.assertEqual(server.failure_code(error), code, error)

class UnitTest(unittest.TestCase):
    def test_moving_still_geometry_matches_the_preview(self):
        self.assertIn("zoompan=z='1.12':x='(iw-iw/zoom)*on/23'", server.motion_filter('pan-right', 720, 1280, 0.8))
        self.assertIn("z='1+0.12*on/23'", server.motion_filter('zoom-in', 720, 1280, 0.8))
        with self.assertRaises(ValueError): server.motion_filter('spin', 720, 1280, 1)

    def test_captions_load_the_bundled_fonts(self):
        with tempfile.TemporaryDirectory(dir=WORK) as directory:
            path = Path(directory) / 'captions.ass'
            path.write_text(ass(720, 1280, (360, 640, 'Bold')) + 'Dialogue: 0,0:00:00.00,0:00:01.00,Box,,0,0,0,,{\\fnNoto Serif\\b0\\i1}Italic\n')
            out = subprocess.run(['ffmpeg','-nostdin','-v','verbose','-f','lavfi','-i','color=c=black:s=720x1280:d=0.1',
                                  '-vf',server.burn(str(path)),'-frames:v','1','-f','null','-'], capture_output=True, text=True).stderr
            for font in ('NotoSans-Bold.ttf', 'NotoSans-Regular.ttf', 'NotoSerif-Italic.ttf'):
                self.assertIn(f"Loading font file '{os.path.join(server.FONTS_DIR, font)}'", out)
            # The face, not the copy: where fonts-noto-core is installed (CI, the container) libass may pick its
            # system file, which is the same Noto release as the bundled one.
            self.assertRegex(out, r'fontselect: \(Noto Sans, 700, 0\) -> [^\n]*, 0, NotoSans-Bold\n')
            self.assertRegex(out, r'fontselect: \(Noto Serif, 400, 100\) -> [^\n]*, 0, NotoSerif-Italic\n')
        with self.assertRaises(ValueError): server.burn('/tmp/x:fontsdir=/etc/captions.ass')

    def test_cancel_stops_the_running_command(self):
        job, result = {'status': 'running'}, {}
        def work():
            server.CURRENT.job = job
            try: server.command(['sleep', '30'], timeout=60)
            except ValueError as e: result['error'] = str(e)
        t = threading.Thread(target=work); t.start()
        for _ in range(50):
            if job.get('proc'): break
            time.sleep(0.05)
        started = time.time()
        job['cancelled'] = True; job['proc'].kill()
        t.join(5)
        self.assertFalse(t.is_alive())
        self.assertLess(time.time() - started, 3)
        self.assertIn('failed', result['error'])

class HttpTest(RendererTest):
    """The API the Worker's container binding talks to (shared/render.ts)."""
    def setUp(self):
        super().setUp()
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base_url = f'http://127.0.0.1:{self.httpd.server_address[1]}'

    def tearDown(self):
        self.httpd.shutdown(); self.httpd.server_close()
        with server.LOCK:
            for job in server.JOBS.values(): shutil.rmtree(job['dir'], ignore_errors=True)
            server.JOBS.clear()

    def call(self, method, path, body=None):
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        request = urllib.request.Request(self.base_url + path, data=data, method=method)
        try:
            with NO_PROXY.open(request, timeout=30) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def json(self, method, path, body=None):
        status, _, data = self.call(method, path, body)
        return status, json.loads(data)

    def wait(self, id, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            status, body = self.json('GET', f'/jobs/{id}')
            if body.get('status') != 'running': return body
            time.sleep(0.1)
        self.fail('job did not finish')

    def test_jobs_run_report_serve_files_and_are_forgotten(self):
        id = '11111111-2222-4333-8444-555555555555'
        payload = {'id': id, 'operation': 'stills', 'width': 720, 'height': 1280, 'synthetic': False, 'urls': [FIXTURES.url('photo.jpg')],
                   'slides': [{'color': '#ffffff', 'ass': ''}, {'input': 0, 'ass': ass(720, 1280, (360, 640, 'Hi'))}]}
        self.assertEqual(self.json('POST', '/jobs', payload), (202, {'status': 'running'}))
        status, body = self.json('POST', '/jobs', payload)
        self.assertEqual(status, 200)
        self.assertIn(body['status'], ('running', 'completed'))
        self.assertEqual(self.wait(id), {'status': 'completed', 'files': 2})
        for n in (0, 1):
            status, headers, data = self.call('GET', f'/jobs/{id}/file/{n}')
            self.assertEqual((status, headers['Content-Type'], int(headers['Content-Length'])), (200, 'image/jpeg', len(data)))
            self.assertEqual(data[:2], b'\xff\xd8')
            self.assertNotIn(b'trainedAlgorithmicMedia', data)
        for path in (f'/jobs/{id}/file/2', f'/jobs/{id}/file/x', f'/jobs/{id}/file', f'/jobs/{id}/other/0', '/jobs/22222222-2222-4333-8444-555555555555'):
            self.assertEqual(self.call('GET', path)[0], 404, path)
        directory = server.JOBS[id]['dir']
        self.assertEqual(self.json('DELETE', f'/jobs/{id}'), (200, {}))
        self.assertEqual(self.call('GET', f'/jobs/{id}')[0], 404)
        self.assertFalse(os.path.exists(directory))
        # A failed job reports a code only.
        bad = {'id': id, 'operation': 'inspect', 'url': FIXTURES.url('broken.bin')}
        self.assertEqual(self.json('POST', '/jobs', bad)[0], 202)
        self.assertEqual(self.wait(id), {'status': 'failed', 'error': 'MEDIA_FORMAT'})
        # An inspect reports meta and duration.
        self.json('DELETE', f'/jobs/{id}')
        self.json('POST', '/jobs', {'id': id, 'operation': 'inspect', 'url': FIXTURES.url('clip.mp4')})
        result = self.wait(id)
        self.assertEqual((result['status'], result['meta'], result['files']), ('completed', {'kind': 'video', 'width': 640, 'height': 360, 'hasAudio': True}, 0))
        self.assertAlmostEqual(result['duration'], 2.0, delta=0.1)

    def test_bad_requests_are_refused(self):
        self.assertEqual(self.call('POST', '/jobs', {'id': 'not-a-uuid', 'operation': 'inspect', 'url': 'x'})[0], 400)
        self.assertEqual(self.call('POST', '/jobs', {'id': '11111111-2222-4333-8444-555555555555', 'operation': 'export'})[0], 400)
        self.assertEqual(self.call('POST', '/jobs', b'{not json')[0], 400)
        self.assertEqual(self.call('POST', '/jobs', b'[1, 2]')[0], 400)
        self.assertEqual(self.call('POST', '/other', {})[0], 404)
        connection = http.client.HTTPConnection('127.0.0.1', self.httpd.server_address[1], timeout=10)
        connection.putrequest('POST', '/jobs'); connection.putheader('Content-Length', str(3 * 1024 * 1024)); connection.endheaders()
        self.assertEqual(connection.getresponse().status, 413)
        connection.close()
        self.assertEqual(server.JOBS, {})

    def test_one_job_at_a_time_and_old_jobs_are_reclaimed(self):
        release = threading.Event()
        def slow(job, payload, id=None):
            release.wait(10)
            job.update(status='completed', files=0, outputs=[], finished=time.time())
        a, b = 'aaaaaaaa-0000-4000-8000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000000'
        with patch.object(server, 'process', slow):
            self.assertEqual(self.json('POST', '/jobs', {'id': a, 'operation': 'inspect'}), (202, {'status': 'running'}))
            self.assertEqual(self.json('POST', '/jobs', {'id': b, 'operation': 'inspect'}), (429, {'status': 'busy'}))
            self.assertEqual(self.json('POST', '/jobs', {'id': a, 'operation': 'inspect'}), (200, {'status': 'running'}))
            release.set()
            self.assertEqual(self.wait(a)['status'], 'completed')
            # Finished jobs the Worker never collected are reclaimed after 30 minutes, on the next POST.
            server.JOBS[a]['finished'] = time.time() - 1801
            directory = server.JOBS[a]['dir']
            self.assertEqual(self.json('POST', '/jobs', {'id': b, 'operation': 'inspect'})[0], 202)
            self.assertNotIn(a, server.JOBS)
            self.assertFalse(os.path.exists(directory))
            self.wait(b)

    def test_delete_stops_a_running_render(self):
        id = 'cccccccc-0000-4000-8000-000000000000'
        payload = {'id': id, 'operation': 'compose', 'urls': [], 'width': 720, 'height': 1280, 'synthetic': False, 'ass': '',
                   'segments': [{'kind': 'color', 'color': '#123456', 'duration': 120}, {'kind': 'color', 'color': '#654321', 'duration': 60}]}
        self.assertEqual(self.json('POST', '/jobs', payload)[0], 202)
        for _ in range(100):
            if server.JOBS[id].get('proc'): break
            time.sleep(0.02)
        directory, started = server.JOBS[id]['dir'], time.time()
        self.assertEqual(self.json('DELETE', f'/jobs/{id}'), (200, {}))
        while id in server.JOBS and time.time() - started < 10: time.sleep(0.05)
        self.assertNotIn(id, server.JOBS)
        self.assertLess(time.time() - started, 5)
        self.assertFalse(os.path.exists(directory))
        self.assertEqual(self.call('GET', f'/jobs/{id}')[0], 404)

if __name__ == '__main__': unittest.main()
