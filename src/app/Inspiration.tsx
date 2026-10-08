import { useState } from "react";
import { Link } from "react-router-dom";
import { Shuffle } from "lucide-react";
import { hookPatterns } from "../../shared/hooks";
import { formatIds, formats, type FormatId } from "../../shared/formats";
import "./create.css";

// Inspiration: the proven short-form structures posts are built on. Remix one for your brand in a click.
export function Inspiration() {
  const [format, setFormat] = useState<FormatId | "all">("all");
  const list = hookPatterns.filter((p) => format === "all" || p.formats.includes(format));
  return (
    <main className="page">
      <div className="page-head">
        <div><h1>Inspiration</h1><p>Hooks and structures that keep working on TikTok, Reels and Shorts. Remix any of them for your brand.</p></div>
      </div>
      <div className="tabs" role="tablist" style={{ marginBottom: 18 }}>
        <button role="tab" aria-selected={format === "all"} onClick={() => setFormat("all")}>All</button>
        {formatIds.map((f) => <button key={f} role="tab" aria-selected={format === f} onClick={() => setFormat(f)}>{formats[f].name}</button>)}
      </div>
      <div className="patterns">
        {list.map((p) => (
          <article key={p.id} className="pattern">
            <strong>{p.name}</strong>
            <p className="template">“{p.template}”</p>
            <p className="muted small">{p.why}</p>
            <div className="row wrap" style={{ gap: 6 }}>{p.formats.map((f) => <span key={f} className="chip">{formats[f].name}</span>)}</div>
            <Link className="btn sm" to={`/app/create?pattern=${p.id}&format=${format === "all" ? p.formats[0] : format}`}><Shuffle size={14} /> Remix this</Link>
          </article>
        ))}
      </div>
    </main>
  );
}
