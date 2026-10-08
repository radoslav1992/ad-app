import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./types";
import { now } from "./types";
import { withDefaults } from "./config";
import { buildProfile, describedPage, readWebsite, saveBrandImages, ScanError, type PageInfo } from "./scan";
import { workspaceProfile } from "./ideas";

// The brand analysis behind onboarding: website (or description) → profile → brand images. Each stage is recorded in
// `scan_step` so the "Preparing workspace" card can show progress while the owner answers the questions.
export class WorkspaceScan extends WorkflowEntrypoint<Env, { workspaceId: string }> {
  async run(event: WorkflowEvent<{ workspaceId: string }>, step: WorkflowStep) {
    const e = withDefaults(this.env), id = event.payload.workspaceId;
    const w = await step.do("load", async () =>
      e.DB.prepare("SELECT id,user_id,name,website,description,profile FROM workspaces WHERE id=? AND scan_status='scanning'").bind(id).first<any>());
    if (!w) return;
    const stage = (value: string) => e.DB.prepare("UPDATE workspaces SET scan_step=?,updated_at=? WHERE id=? AND scan_status='scanning'").bind(value, now(), id).run();
    try {
      const pages = await step.do("website", { retries: { limit: 1, delay: "5 seconds" }, timeout: "3 minutes" }, async (): Promise<PageInfo[]> => {
        await stage("website");
        // A written description (the latest choice) wins over an earlier website.
        if (w.description) return [describedPage(w.name, w.description)];
        if (!w.website) throw new ScanError("WEBSITE_INVALID");
        return readWebsite(w.website);
      });
      await step.do("profile", { retries: { limit: 1, delay: "10 seconds" }, timeout: "3 minutes" }, async () => {
        await stage("profile");
        const current = await e.DB.prepare("SELECT profile FROM workspaces WHERE id=?").bind(id).first<{ profile: string }>();
        const profile = await buildProfile(e, pages, workspaceProfile(current || w));
        await e.DB.prepare("UPDATE workspaces SET profile=?,updated_at=? WHERE id=?").bind(JSON.stringify(profile), now(), id).run();
      });
      if (pages.some((p) => p.images.length))
        await step.do("images", { retries: { limit: 1, delay: "10 seconds" }, timeout: "5 minutes" }, async () => {
          await stage("images");
          return saveBrandImages(e, w.user_id, id, pages);
        });
      await step.do("done", async () => {
        await e.DB.prepare("UPDATE workspaces SET scan_status='ready',scan_step='done',scan_error=NULL,scanned_at=?,updated_at=? WHERE id=?").bind(now(), now(), id).run();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = error instanceof ScanError || /^WEBSITE_[A-Z_]+$/.test(message) ? message : "SCAN_FAILED";
      console.error("Brand analysis failed", { workspaceId: id, code });
      await step.do("failed", async () => {
        await e.DB.prepare("UPDATE workspaces SET scan_status='failed',scan_error=?,updated_at=? WHERE id=?").bind(code, now(), id).run();
      });
    }
  }
}
