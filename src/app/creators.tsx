/**
 * Creators at scale: browsing a library of hundreds or thousands of AI creators a page at a time.
 *
 * - usePaged(path, params) → { items, setItems, first, setFirst, next, loading, loadingMore, error, moreError, loadMore, reload }
 *     Keyset-paged lists from GET `path` ({ characters, next } pages). Changing `params` starts again (the previous
 *     results stay on screen, dimmed, until the new ones arrive); `first` is the whole first-page answer (counts…).
 * - useCreators(q, gender, source, limit?) — usePaged over GET /api/characters (counts per source, creators being made).
 * - useDebounced(value, ms?) — the value once it stopped changing (for search boxes).
 * - <LoadMore … /> — loads the next page as it scrolls into view, with a button and a "Showing x of y" status.
 * - gridKeys(event) — arrow keys, Home and End move focus between the [data-grid-item] buttons of a [data-grid].
 * - <CreatorPicker selected? title? onPick onClose /> — a modal to search, filter and choose one creator.
 * - <CreatorField value onChange onClear? label? emptyLabel? /> — the chosen creator with a Change button that opens
 *     the picker; onChange(id, creator) gets the whole creator (price tier, portrait) for the caller's own state.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { Check, Crown, Search, UserRound, X } from "lucide-react";
import { Modal, Spinner } from "../ui";
import { api, errorText, number, useApi, type Character } from "../lib";
import type { CreatorGender, CreatorSource } from "../../shared/creators";
import { GridSkeleton, useStableCallback } from "./pickers";
import "./creators.css";

export type Making = { id: string; name: string };
type Page<T> = { characters: T[]; next: string | null };
export type CreatorCounts = { library: number; own: number };

/** The value once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** A keyset-paged list; see the module comment. */
export function usePaged<T extends { id: string }, X extends object = object>(path: string, params: Record<string, string>) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "")).toString();
  const [items, setItems] = useState<T[]>([]);
  const [first, setFirst] = useState<(X & Page<T>) | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // One controller per search: a new search or leaving the page drops answers that are no longer wanted.
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    controller.current = ctl;
    setLoading(true);
    setLoadingMore(false);
    setMoreError(null);
    api<X & Page<T>>(`${path}?${query}`, { signal: ctl.signal }).then((r) => {
      setItems(r.characters);
      setFirst(r);
      setNext(r.next);
      setError(null);
      setLoading(false);
    }, (e) => {
      if (ctl.signal.aborted) return;
      setError(errorText(e));
      setLoading(false);
    });
    return () => ctl.abort();
  }, [path, query, version]);
  const loadMore = useCallback(() => {
    const ctl = controller.current;
    if (!next || loading || loadingMore || !ctl) return;
    setLoadingMore(true);
    setMoreError(null);
    api<Page<T>>(`${path}?${query}${query ? "&" : ""}cursor=${encodeURIComponent(next)}`, { signal: ctl.signal }).then((r) => {
      setItems((list) => {
        const have = new Set(list.map((i) => i.id));
        return [...list, ...r.characters.filter((i) => !have.has(i.id))];
      });
      setNext(r.next);
      setLoadingMore(false);
    }, (e) => {
      if (ctl.signal.aborted) return;
      setMoreError(errorText(e));
      setLoadingMore(false);
    });
  }, [path, query, next, loading, loadingMore]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { items, setItems, first, setFirst, next, loading, loadingMore, error, moreError, loadMore, reload };
}

/** Creators to choose from (GET /api/characters): own first, then the library, newest first. */
export function useCreators(q: string, gender: CreatorGender, source: CreatorSource, limit = 48) {
  return usePaged<Character, { counts?: CreatorCounts; making?: Making[] }>("/characters", {
    q, gender, source: source === "all" ? "" : source, limit: String(limit),
  });
}
/** How many creators the current list holds in total (from the first page's counts). */
export const creatorTotal = (counts: CreatorCounts | undefined, source: CreatorSource) =>
  counts ? (source === "all" ? counts.library + counts.own : counts[source]) : undefined;

/** Loads the next page when this row nears the viewport; the button does the same for keyboards and old browsers. */
export function LoadMore({ next, loading, error, shown, total, noun, onMore }: {
  next: string | null; loading: boolean; error: string | null; shown: number; total?: number; noun: string; onMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const more = useStableCallback(onMore);
  useEffect(() => {
    const el = ref.current;
    // Re-observed for every page, so a screen tall enough to show the row again keeps loading.
    if (!el || !next || error || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [next, error, more]);
  if (!shown) return null;
  return (
    <div className="more-row" ref={ref}>
      <p className="small muted" aria-live="polite">
        {total !== undefined && total >= shown ? `Showing ${number(shown)} of ${number(total)} ${noun}` : `Showing ${number(shown)} ${noun}`}
      </p>
      {error ? (
        <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={onMore}>Try again</button></div>
      ) : next && (
        <button type="button" className="btn sm" onClick={onMore} disabled={loading}>{loading && <Spinner label="Loading more" />}{loading ? "Loading…" : "Load more"}</button>
      )}
    </div>
  );
}

/** Arrow keys (and Home/End) move focus between the buttons of a grid; the column count is read from the layout. */
export function gridKeys(e: ReactKeyboardEvent<HTMLElement>) {
  if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const grid = e.currentTarget.closest("[data-grid]");
  const items = grid ? [...grid.querySelectorAll<HTMLElement>("[data-grid-item]")] : [];
  const i = items.indexOf(e.currentTarget);
  if (i < 0) return;
  const top = items[0].getBoundingClientRect().top;
  const wrap = items.findIndex((el) => el.getBoundingClientRect().top > top + 1);
  const cols = wrap > 0 ? wrap : items.length;
  const moves: Record<string, number> = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: items.length - 1 };
  const to = moves[e.key] ?? i;
  if (to < 0 || to >= items.length || to === i) return;
  e.preventDefault();
  items[to].focus();
  items[to].scrollIntoView({ block: "nearest" });
}

export const genderOptions: { id: CreatorGender; label: string }[] = [{ id: "", label: "Any" }, { id: "female", label: "Female" }, { id: "male", label: "Male" }];

/** A modal to search, filter and choose one creator among any number. */
export function CreatorPicker({ title = "Choose a creator", selected = null, onPick, onClose }: {
  title?: string; selected?: string | null; onPick: (creator: Character) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState<CreatorGender>("");
  const [source, setSource] = useState<CreatorSource>("all");
  const list = useCreators(useDebounced(query.trim()), gender, source, 40);
  const [picked, setPicked] = useState<Character | null>(null);
  const close = useStableCallback(onClose);
  const grid = useRef<HTMLUListElement>(null);
  // The creator already in use counts as chosen once it's on a loaded page.
  const chosen = picked ?? list.items.find((c) => c.id === selected) ?? null;
  const chosenId = chosen?.id ?? selected;
  const counts = list.first?.counts;
  const filtered = !!query.trim() || !!gender;
  // One tab stop in the grid: the chosen creator if it's shown, otherwise the first.
  const focusId = list.items.some((c) => c.id === chosenId) ? chosenId : list.items[0]?.id;
  const clear = () => { setQuery(""); setGender(""); };
  const sources: { id: CreatorSource; label: string }[] = [{ id: "all", label: "All" }, { id: "library", label: "Library" }, { id: "own", label: "Yours" }];
  return (
    <Modal title={title} onClose={close} wide footer={
      <>
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="button" className="btn primary" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>
          <Check size={16} aria-hidden="true" />{chosen ? `Use ${chosen.name}` : "Use this creator"}
        </button>
      </>
    }>
      <div className="pick-toolbar">
        <label className="search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search creators by name or description</span>
          <input className="input" type="search" placeholder="Search by name or description" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); grid.current?.querySelector<HTMLElement>("[tabindex='0']")?.focus(); } }} />
        </label>
        <label className="row small">
          <span className="muted">Gender</span>
          <select className="select compact" value={gender} onChange={(e) => setGender(e.target.value as CreatorGender)}>
            {genderOptions.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </label>
      </div>
      <div className="tag-filter" role="group" aria-label="Show">
        {sources.map((s) => (
          <button key={s.id} type="button" className="chip button" aria-pressed={source === s.id} onClick={() => setSource(s.id)}>
            {s.label}{counts && ` · ${number(creatorTotal(counts, s.id) || 0)}`}
          </button>
        ))}
      </div>
      <p id="creator-pick-hint" className="sr-only">Arrow keys move between creators. Enter selects one; Enter again uses it.</p>
      {list.loading && !list.items.length ? (
        <GridSkeleton count={10} className="pick-grid creator-pick" />
      ) : list.error && !list.items.length ? (
        <div className="notice bad" role="alert">{list.error} <button type="button" className="link" onClick={list.reload}>Try again</button></div>
      ) : !list.items.length ? (
        <div className="empty">
          <span className="empty-icon" aria-hidden="true"><UserRound size={24} /></span>
          {filtered ? (
            <><h3>No creators match</h3><p>Try other words or another filter.</p><button type="button" className="btn" onClick={clear}>Clear search and filters</button></>
          ) : source === "own" ? (
            <><h3>You haven't made a creator yet</h3><p>Describe someone, or turn your own photo into a talking creator.</p><Link to="/app/characters" className="btn">Go to Creators</Link></>
          ) : (
            <><h3>No creators yet</h3><p>Library creators are on their way. Meanwhile, you can make your own.</p><Link to="/app/characters" className="btn">Go to Creators</Link></>
          )}
        </div>
      ) : (
        <ul ref={grid} className={`pick-grid creator-pick list-plain${list.loading ? " list-stale" : ""}`} data-grid aria-busy={list.loading} aria-label="Creators">
          {list.items.map((c) => (
            <li key={c.id}>
              <CreatorTile creator={c} selected={c.id === chosenId} focusable={c.id === focusId}
                onSelect={() => (c.id === chosen?.id ? onPick(c) : setPicked(c))} />
            </li>
          ))}
        </ul>
      )}
      <LoadMore next={list.next} loading={list.loadingMore} error={list.moreError} shown={list.items.length} total={creatorTotal(counts, source)} noun="creators" onMore={list.loadMore} />
    </Modal>
  );
}
function CreatorTile({ creator: c, selected, focusable, onSelect }: { creator: Character; selected: boolean; focusable: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="pick-item portrait" data-grid-item aria-pressed={selected} tabIndex={focusable ? 0 : -1} onClick={onSelect} onKeyDown={gridKeys}
      aria-label={`${c.name}${c.own ? ", yours" : ""}${c.premium ? ", premium" : ""}`} aria-describedby="creator-pick-hint" title={c.description || c.name}>
      <img src={c.image} alt="" loading="lazy" decoding="async" />
      {(c.own || c.premium) && (
        <span className="badge-row" aria-hidden="true">
          {c.own && <span className="chip dark">Yours</span>}
          {c.premium && <span className="chip orange"><Crown size={11} />Premium</span>}
        </span>
      )}
      {selected && <span className="pick-check" aria-hidden="true"><Check size={15} /></span>}
      <span className="pick-name" aria-hidden="true">{c.name}</span>
    </button>
  );
}

/** The chosen creator and a button to change it (the picker opens on top). */
export function CreatorField({ value, onChange, onClear, label = "Creator", emptyLabel = "Any creator" }: {
  value?: string | null; onChange: (id: string, creator: Character) => void; onClear?: () => void; label?: string; emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [known, setKnown] = useState<Character | null>(null);
  // A creator chosen elsewhere (a link, a draft) is looked up once; one picked here is already known.
  const lookup = useApi<{ character: Character }>(value && known?.id !== value ? `/characters/${encodeURIComponent(value)}` : null);
  const found = lookup.data?.character;
  const c = known?.id === value ? known : found?.id === value ? found : null;
  const state = c ? (c.own ? "Yours" : "Library") + (c.premium ? " · Premium" : "") : value ? (lookup.error ? "This creator isn't available any more." : "Loading…") : "The writer picks one.";
  return (
    <div className="creator-field">
      <span className="label">{label}</span>
      <div className="creator-chosen">
        {c ? <img src={c.image} alt="" /> : <span className="portrait-slot" aria-hidden="true"><UserRound size={20} /></span>}
        <div className="grow">
          <strong title={c?.name}>{c ? c.name : value ? "Chosen creator" : emptyLabel}</strong>
          <span className="small muted">{state}</span>
        </div>
        {value && onClear && <button type="button" className="btn icon sm ghost" onClick={onClear} aria-label={`Clear ${label.toLowerCase()}`}><X size={16} /></button>}
        <button type="button" className="btn sm" onClick={() => setOpen(true)} aria-label={value ? `Change ${label.toLowerCase()}` : `Choose ${label.toLowerCase()}`}>{value ? "Change" : "Choose"}</button>
      </div>
      {open && <CreatorPicker selected={value} onClose={() => setOpen(false)} onPick={(p) => { setKnown(p); setOpen(false); onChange(p.id, p); }} />}
    </div>
  );
}
