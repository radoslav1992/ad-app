import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App } from "../types";
import { uid, now, ready, mediaEnabled, DAY } from "../types";
import { defer, hit, rate, sendMail, verifyTurnstile } from "../security";
import { PRODUCT } from "../../shared/brand";

export const contactTopics = { question: "Question", billing: "Billing", partnership: "Partnership", abuse: "Report abuse", other: "Other" } as const;
/** Unauthenticated API: site configuration and the contact form. */
export const publicRoutes = new Hono<App>();
publicRoutes.get("/api/public/config", (c) =>
  c.json({
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null,
    registrationEnabled: c.env.REGISTRATION_ENABLED === "true" && ready(c.env),
    billingEnabled: c.env.BILLING_ENABLED === "true",
    mediaEnabled: mediaEnabled(c.env),
    company: { name: c.env.COMPANY_NAME || null, address: c.env.COMPANY_ADDRESS || null, email: c.env.CONTACT_EMAIL || null },
  }),
);
publicRoutes.post("/api/contact", async (c) => {
  await rate(c, "contact", 5);
  const body = await c.req.json();
  const d = z.object({
    name: z.string().trim().min(2).max(80),
    email: z.email().max(254),
    topic: z.enum(Object.keys(contactTopics) as [keyof typeof contactTopics]),
    message: z.string().trim().min(10).max(4000),
  }).parse(body);
  if (c.env.TURNSTILE_SECRET_KEY && !(await verifyTurnstile(c.env, body.turnstileToken, c.req.header("CF-Connecting-IP"))))
    throw new HTTPException(400, { message: "Please complete the security check." });
  // One mailbox cannot flood the inbox from rotating addresses.
  if ((await hit(c.env, "contact-email", DAY, d.email.toLowerCase())) > 5) return c.json({ ok: true });
  await c.env.DB.prepare("INSERT INTO contact_messages(id,name,email,topic,message,created_at) VALUES (?,?,?,?,?,?)")
    .bind(uid(), d.name, d.email, d.topic, d.message, now()).run();
  const admins = (c.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (admins.length && c.env.EMAIL)
    await defer(c, Promise.all(admins.map((to) =>
      sendMail(c.env, to, `${PRODUCT.name} contact: ${contactTopics[d.topic]}`, `From: ${d.name} <${d.email}>\nTopic: ${contactTopics[d.topic]}\n\n${d.message}`),
    )).catch(() => console.error("Contact notification failed")));
  return c.json({ ok: true });
});
