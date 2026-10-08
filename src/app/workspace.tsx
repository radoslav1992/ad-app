import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Workspace } from "../lib";

// The workspace (brand) the dashboard shows. The choice is remembered in this browser.
type Ctx = {
  workspaces: Workspace[];
  workspace: Workspace | null;
  loading: boolean;
  select: (id: string) => void;
  refresh: () => Promise<Workspace[]>;
  /** Replaces the current workspace after an edit (without a reload). */
  update: (w: Workspace) => void;
};
const WorkspaceContext = createContext<Ctx>({ workspaces: [], workspace: null, loading: true, select: () => {}, refresh: async () => [], update: () => {} });
export const useWorkspace = () => useContext(WorkspaceContext);
/** The current workspace, for pages that only render inside the dashboard (which guarantees one). */
export const useCurrentWorkspace = () => useContext(WorkspaceContext).workspace!;
const KEY = "pl-workspace";
const remembered = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [current, setCurrent] = useState<string | null>(remembered);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const { workspaces } = await api<{ workspaces: Workspace[] }>("/workspaces");
      setWorkspaces(workspaces);
      return workspaces;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);
  const select = useCallback((id: string) => {
    setCurrent(id);
    try { localStorage.setItem(KEY, id); } catch { /* private mode */ }
  }, []);
  const update = useCallback((w: Workspace) => setWorkspaces((all) => all.map((x) => (x.id === w.id ? { ...x, ...w } : x))), []);
  const workspace = workspaces.find((w) => w.id === current) || workspaces[0] || null;
  return <WorkspaceContext.Provider value={{ workspaces, workspace, loading, select, refresh, update }}>{children}</WorkspaceContext.Provider>;
}
