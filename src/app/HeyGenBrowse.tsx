import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Search, UserRound } from "lucide-react";
import { Spinner } from "../ui";
import { api, errorText, number, post } from "../lib";
import { type LookImport } from "../../shared/creators";
import "./admin.css";

// Admin → Creators → Add library creators → "Browse HeyGen": HeyGen's stock looks, page by page, with previews (served
// by our own /api/admin/heygen/image, never hotlinked), filters from the data, multi-select and "in the library"
// marks. The selection goes through the same bulk import as pasted IDs, which checks every look again. Ported from
// rech-bg's stock avatar browser (src/AvatarLibrary.tsx).

type StockLook = {
  id: string; name: string; gender: string; tags: string[]; engines: string[]; importable: boolean;
  library: { id: string; name: string; active: boolean } | null; image: string | null;
};
/** Pages (of 50) per loading run; "Load more" continues. HeyGen's list has no search, so matching happens here. */
const PAGES_PER_RUN = 20, SHOWN = 48, IMPORT_CHUNK = 10;
const engineNames: Record<string, string> = { avatar_iii: "Avatar III", avatar_iv: "Avatar IV", avatar_v: "Avatar V" };
const engineName = (e: string) => engineNames[e] || e.replace(/_/g, " ");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const importLabels: Record<LookImport["status"], { label: string; tone: string }> = {
  failed: { label: "Failed, try again", tone: "red" }, unusable: { label: "Can't be used", tone: "orange" }, exists: { label: "Already in the library", tone: "" }, imported: { label: "Imported", tone: "green" },
};

export function BrowseHeyGen({ onDone }: { onDone: () => void }) {
  const [looks, setLooks] = useState<StockLook[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState("");
  const [onlyImportable, setOnlyImportable] = useState(true);
  const [hideAdded, setHideAdded] = useState(false);
  const [limit, setLimit] = useState(SHOWN);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [rights, setRights] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<LookImport[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const rightsBox = useRef<HTMLInputElement>(null);
  // Each loading run has a number; a newer run, Stop or leaving the page ends the older one.
  const run = useRef(0), stopImport = useRef(false);
  useEffect(() => () => { run.current++; }, []);
  useEffect(() => { setLimit(SHOWN); }, [query, gender, onlyImportable, hideAdded]);

  const load = async (page?: string) => {
    const id = ++run.current;
    setLoading(true);
    setError(null);
    try {
      let token = page;
      for (let n = 0; n < PAGES_PER_RUN; n++) {
        const d = await api<{ looks: StockLook[]; nextPage: string | null }>(`/admin/heygen/looks${token ? `?page=${encodeURIComponent(token)}` : ""}`);
        if (id !== run.current) return;
        const first = !token;
        setLooks((all) => {
          if (first || !all) return d.looks;
          const have = new Set(all.map((x) => x.id));
          return [...all, ...d.looks.filter((x) => !have.has(x.id))];
        });
        setNext(d.nextPage);
        if (!d.nextPage) break;
        token = d.nextPage;
      }
    } catch (e) {
      if (id === run.current) setError(errorText(e));
    } finally {
      if (id === run.current) setLoading(false);
    }
  };
  const stop = () => { run.current++; setLoading(false); };

  const genders = useMemo(() => [...new Set((looks || []).map((l) => l.gender).filter(Boolean))].sort(), [looks]);
  const unnamedGender = !!looks?.some((l) => !l.gender);
  const q = query.trim().toLowerCase();
  const matches = (looks || []).filter((l) =>
    (!onlyImportable || l.importable) && (!hideAdded || !l.library) && (!gender || (gender === "none" ? !l.gender : l.gender === gender)) &&
    (!q || `${l.name} ${l.tags.join(" ")}`.toLowerCase().includes(q)));
  const shown = matches.slice(0, limit);
  const pickable = (l: StockLook) => l.importable && !l.library;
  const toggle = (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const selectable = matches.filter(pickable);
  const allSelected = selectable.length > 0 && selectable.every((l) => selected.has(l.id));

  const importSelected = async () => {
    if (progress) return;
    setProblem(null);
    if (!rights) {
      setProblem("First confirm that your HeyGen plan lets you offer these looks to your users.");
      rightsBox.current?.focus();
      return;
    }
    const chosen = (looks || []).filter((l) => selected.has(l.id) && pickable(l));
    if (!chosen.length) return;
    // The bulk import sets one gender per request: HeyGen's own gender goes with each look.
    const groups = new Map<string, string[]>();
    for (const l of chosen) {
      const g = ["female", "male"].includes(l.gender) ? l.gender : "";
      groups.set(g, [...(groups.get(g) || []), l.id]);
    }
    stopImport.current = false;
    const all: LookImport[] = [];
    setResults([]);
    setProgress({ done: 0, total: chosen.length });
    try {
      for (const [g, ids] of groups)
        for (let i = 0; i < ids.length && !stopImport.current; i += IMPORT_CHUNK) {
          const r = await post<{ results: LookImport[] }>("/admin/characters/import/bulk", { lookIds: ids.slice(i, i + IMPORT_CHUNK), gender: g });
          all.push(...r.results);
          setResults([...all]);
          setProgress({ done: all.length, total: chosen.length });
          // Imported (or found already there): marked as in the library and taken out of the selection.
          const added = new Map(r.results.filter((x) => (x.status === "imported" || x.status === "exists") && x.id).map((x) => [x.lookId, x]));
          setLooks((list) => list && list.map((l) => {
            const x = added.get(l.id);
            return x ? { ...l, library: { id: x.id!, name: x.name || l.name, active: x.status === "imported" || !x.error } } : l;
          }));
          setSelected((s) => { const n = new Set(s); for (const id of added.keys()) n.delete(id); return n; });
        }
      if (all.length < chosen.length) setProblem(`Stopped after ${number(all.length)} of ${number(chosen.length)}. The rest are still selected.`);
    } catch (err) {
      setProblem(`${errorText(err)}${all.length ? ` ${number(all.length)} of ${number(chosen.length)} were checked; the rest are still selected.` : ""}`);
    } finally {
      setProgress(null);
      if (all.some((r) => r.status === "imported")) onDone();
    }
  };
  const counts = { imported: 0, exists: 0, unusable: 0, failed: 0 };
  for (const r of results) counts[r.status]++;
  const issues = results.filter((r) => r.status === "failed" || r.status === "unusable");
  const nameOf = (id: string) => looks?.find((l) => l.id === id)?.name || id;

  if (!looks)
    return (
      <div>
        <p className="muted small" style={{ marginBottom: 14 }}>
          Pick from HeyGen's stock looks instead of pasting IDs. Only looks with the Avatar III engine can be imported; each is checked again, named after
          the look and given its preview as the portrait. Before you add them, check that your HeyGen plan and terms let you offer stock avatars to your users.
        </p>
        {error && <div className="notice bad" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
        <button type="button" className="btn primary" onClick={() => void load()} disabled={loading}>{loading ? <Spinner label="Loading" /> : <Search size={16} aria-hidden="true" />}Show HeyGen's looks</button>
      </div>
    );
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="filter-bar hg-filters">
        <label className="search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search by name or tag</span>
          <input className="input" type="search" placeholder="Name or tag, e.g. office" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <select className="select compact" value={gender} onChange={(e) => setGender(e.target.value)} aria-label="Gender">
          <option value="">Any gender</option>
          {genders.map((g) => <option key={g} value={g}>{capital(g)}</option>)}
          {unnamedGender && <option value="none">Not given</option>}
        </select>
        <label className="check"><input type="checkbox" checked={onlyImportable} onChange={(e) => setOnlyImportable(e.target.checked)} /><span>Avatar III only (importable)</span></label>
        <label className="check"><input type="checkbox" checked={hideAdded} onChange={(e) => setHideAdded(e.target.checked)} /><span>Hide looks in the library</span></label>
      </div>
      <label className="check">
        <input ref={rightsBox} type="checkbox" checked={rights} onChange={(e) => { setRights(e.target.checked); setProblem(null); }} />
        <span>My HeyGen plan and terms let me offer HeyGen's stock avatars to my users for making content.</span>
      </label>
      <div className="row wrap hg-status">
        <span className="small muted" role="status">
          {number(looks.length)} looks loaded{loading ? " · loading more…" : next ? " · more on HeyGen" : " · all of them"} · {number(matches.length)} match
        </span>
        {loading ? <button type="button" className="btn sm" onClick={stop}>Stop</button>
          : next && <button type="button" className="btn sm" onClick={() => void load(next)}>Load more</button>}
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {shown.length ? (
        <ul className="list-plain hg-grid" aria-label="HeyGen stock looks">
          {shown.map((l) => {
            const on = selected.has(l.id);
            return (
              <li key={l.id}>
                <label className={`hg-card${on ? " on" : ""}${pickable(l) ? "" : " off"}`}>
                  <input type="checkbox" className="hg-check" checked={on} disabled={!pickable(l) || !!progress} onChange={(e) => toggle(l.id, e.target.checked)} />
                  <span className="hg-photo">
                    {l.image ? <img src={l.image} alt="" loading="lazy" decoding="async" width={150} height={200} /> : <UserRound size={28} aria-hidden="true" />}
                    {l.library && <span className="hg-mark"><Check size={12} aria-hidden="true" />{l.library.active ? "In library" : "In library · off"}</span>}
                  </span>
                  <strong className="hg-name">{l.name || "Unnamed look"}</strong>
                  <span className="small muted">{l.gender ? capital(l.gender) : "Gender not given"}</span>
                  <span className="hg-engines">
                    {l.engines.length ? l.engines.map((e) => <span key={e} className={`chip${e === "avatar_iii" ? " green" : ""}`}>{engineName(e)}</span>) : <span className="chip">No API engine</span>}
                  </span>
                  {!l.importable && <span className="small muted">{l.engines.includes("avatar_iii") ? "No preview to use" : "No Avatar III: can't be imported"}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">No looks{q ? ` for “${query.trim()}”` : ""} with these filters.{next ? " Load more to search the rest." : ""}</p>
      )}
      {matches.length > limit && <button type="button" className="btn" style={{ alignSelf: "center" }} onClick={() => setLimit((n) => n + SHOWN)}>Show {number(Math.min(SHOWN, matches.length - limit))} more</button>}
      {problem && <div className="notice bad" role="alert">{problem}</div>}
      {(selected.size > 0 || !!progress) && (
        <div className="bulk-bar" role="region" aria-label="Selected looks">
          <span><strong>{number(selected.size)}</strong> selected</span>
          <div className="row">
            {!allSelected && selectable.length > 0 && <button type="button" className="btn sm" disabled={!!progress} onClick={() => setSelected(new Set(selectable.map((l) => l.id)))}>Select all {number(selectable.length)} matches</button>}
            <button type="button" className="btn sm ghost" disabled={!!progress} onClick={() => setSelected(new Set())}>Clear</button>
            <button type="button" className="btn sm primary" disabled={!!progress || !selected.size} onClick={() => void importSelected()}>
              {progress && <Spinner label="Importing" />}Import {number(selected.size)} look{selected.size === 1 ? "" : "s"}
            </button>
            {progress && <button type="button" className="btn sm" onClick={() => { stopImport.current = true; }}>Stop</button>}
            {progress && <span className="small muted">Checked {number(progress.done)} of {number(progress.total)}…</span>}
          </div>
        </div>
      )}
      {results.length > 0 && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="row wrap" role="status">
            {(["imported", "exists", "unusable", "failed"] as const).filter((s) => counts[s]).map((s) => <span key={s} className={`chip ${importLabels[s].tone}`}>{importLabels[s].label} · {number(counts[s])}</span>)}
          </div>
          {issues.length > 0 && (
            <ul className="list-plain hg-issues">
              {issues.map((r) => <li key={r.lookId}><strong>{nameOf(r.lookId)}</strong> <span className={`chip ${importLabels[r.status].tone}`}>{importLabels[r.status].label}</span> <span className="small">{r.error}</span></li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
