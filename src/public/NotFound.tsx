import { Link } from "react-router-dom";
import { ArrowLeft, LayoutDashboard } from "lucide-react";
import { useAuth } from "../lib";
import "./public.css";

/** Unknown addresses (rendered inside the public layout). */
export function NotFound() {
  const { user } = useAuth();
  return (
    <div className="wrap status-page">
      <div>
        <p className="big-code" aria-hidden="true">404</p>
        <h1>This page doesn't exist</h1>
        <p className="lead">The link may be old or mistyped. Nothing is lost — your posts and schedule are where you left them.</p>
        <div className="status-actions">
          <Link className="btn white big" to="/"><ArrowLeft size={18} aria-hidden="true" /> Back to the home page</Link>
          <Link className="btn outline-light big" to="/app"><LayoutDashboard size={18} aria-hidden="true" /> {user ? "Open the app" : "Go to the app"}</Link>
        </div>
      </div>
    </div>
  );
}
