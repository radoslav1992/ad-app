import type { FormatId } from "./formats";

// Proven short-form structures the idea writer builds on. They are patterns, not live trend data: each batch picks
// a mix of them for the brand and avoids the ones it used most recently.
export type HookPattern = { id: string; name: string; template: string; formats: FormatId[]; why: string };
export const hookPatterns: HookPattern[] = [
  { id: "pov", name: "POV", template: "POV: you finally {found the fix for a pain}", formats: ["text", "hook_demo", "slideshow"], why: "Puts the viewer inside the moment of relief." },
  { id: "wish-knew", name: "Wish I knew", template: "Things I wish I knew before {doing the thing}", formats: ["slideshow", "ugc", "story", "carousel"], why: "Promises saved time and mistakes." },
  { id: "stop-doing", name: "Stop doing this", template: "Stop {common mistake}. Do this instead", formats: ["ugc", "text", "slideshow", "carousel"], why: "A gentle callout makes people check themselves." },
  { id: "hacks", name: "Hacks nobody talks about", template: "{N} {category} hacks nobody talks about", formats: ["slideshow", "ugc", "story", "carousel"], why: "Curiosity plus a clear count." },
  { id: "tried-it", name: "I tried it", template: "I tried {product} for 7 days — here's what happened", formats: ["ugc", "hook_demo"], why: "A story with a result at the end." },
  { id: "your-sign", name: "This is your sign", template: "This is your sign to {take the action}", formats: ["text", "slideshow"], why: "Permission to act now." },
  { id: "nobody-talks", name: "Why is nobody talking about", template: "Why is nobody talking about {the benefit}?", formats: ["text", "ugc", "hook_demo", "story"], why: "Feels like an insider secret." },
  { id: "seconds-trick", name: "The N-second trick", template: "The {N}-second trick that {gets the result}", formats: ["hook_demo", "text"], why: "A fast, concrete payoff." },
  { id: "unpopular", name: "Unpopular opinion", template: "Unpopular opinion: {contrarian take}", formats: ["text", "ugc"], why: "Disagreement drives comments." },
  { id: "if-you", name: "If you struggle with", template: "If you {struggle with the pain}, watch this", formats: ["ugc", "hook_demo", "text", "story"], why: "Calls out exactly the right viewer." },
  { id: "before-after", name: "Before vs after", template: "Me before {product} vs after", formats: ["slideshow", "hook_demo", "text", "carousel"], why: "Visible transformation." },
  { id: "how-i", name: "How I did it", template: "How I {got the result} without {the usual pain}", formats: ["ugc", "slideshow", "story", "carousel"], why: "Outcome plus removed obstacle." },
  { id: "doing-wrong", name: "You're doing it wrong", template: "You're doing {task} wrong", formats: ["text", "ugc", "hook_demo", "story", "carousel"], why: "Mild provocation, instant check." },
  { id: "for-you", name: "This one's for you", template: "{Audience}, this one's for you", formats: ["text", "ugc"], why: "Direct address to a niche." },
  { id: "red-flags", name: "Red flags", template: "Red flags when choosing a {category}", formats: ["slideshow", "ugc", "story", "carousel"], why: "Protective, highly saved." },
  { id: "how-to-fast", name: "How to, fast", template: "How to {get the result} in {short time}", formats: ["slideshow", "hook_demo", "carousel"], why: "Clear promise, clear time." },
  { id: "routine", name: "My routine", template: "My {category} routine that actually works", formats: ["slideshow", "ugc", "carousel"], why: "Personal and copyable." },
  { id: "underrated", name: "Underrated tools", template: "Underrated {category} tools you need", formats: ["slideshow", "text", "story", "carousel"], why: "Discovery and saves." },
  { id: "reply", name: "Reply to a comment", template: "Replying to \"{a real question your audience asks}\"", formats: ["ugc", "text"], why: "Looks like an ongoing conversation." },
  { id: "storytime", name: "Storytime", template: "Storytime: how {a small moment} changed {an outcome}", formats: ["ugc", "slideshow", "story"], why: "Narrative keeps people watching." },
  { id: "expectation", name: "Expectation vs reality", template: "{Thing}: expectation vs reality", formats: ["slideshow", "text", "story", "carousel"], why: "Relatable contrast, often funny." },
  { id: "signs", name: "Signs you need", template: "{N} signs you need {product category}", formats: ["slideshow", "ugc", "story", "carousel"], why: "Self-diagnosis that ends at the product." },
  { id: "easiest-way", name: "The easiest way", template: "The easiest way to {get the result}", formats: ["hook_demo", "ugc"], why: "Low effort is the strongest promise." },
  { id: "save-this", name: "Save this", template: "Save this for the next time you {situation}", formats: ["slideshow", "text", "carousel"], why: "Explicit save prompt." },
  { id: "wait-for-it", name: "Wait for it", template: "{Setup}… wait for it", formats: ["hook_demo", "text"], why: "Holds attention to the reveal." },
  { id: "rating", name: "Rating so you don't have to", template: "Rating {category} options so you don't have to", formats: ["slideshow", "ugc", "carousel"], why: "Saves the viewer's research." },
  { id: "mistakes", name: "Biggest mistakes", template: "{N} mistakes everyone makes with {topic}", formats: ["slideshow", "ugc", "text", "story", "carousel"], why: "Fear of missing something." },
  { id: "day-n", name: "Day N", template: "Day {N} of {working toward a goal} with {product}", formats: ["ugc", "text"], why: "Serial content people follow." },
  { id: "tell-me", name: "Tell me without telling me", template: "Tell me you {identity} without telling me you {identity}", formats: ["text", "slideshow"], why: "In-group humour." },
  { id: "myths", name: "Myths, busted", template: "{N} myths about {topic}, busted", formats: ["carousel", "slideshow"], why: "Correcting what people believe makes them stop, and save it." },
  { id: "just-makes-sense", name: "Things that just make sense", template: "Things that just make sense: {product feature}", formats: ["text", "hook_demo", "slideshow"], why: "Satisfying, shareable." },
];
export const hookPatternById = (id: string | undefined) => hookPatterns.find((p) => p.id === id);

/** How the words are written (the "Style" of a manual post). */
export const writingStyles = {
  quick_thought: { name: "Quick thought", brief: "a candid, lowercase, first-person thought, like a note to followers" },
  storytime: { name: "Storytime", brief: "a short personal story with a turn at the end" },
  listicle: { name: "List of tips", brief: "a numbered list of concrete, useful tips" },
  hot_take: { name: "Hot take", brief: "a bold, slightly contrarian opinion that invites replies" },
  relatable: { name: "Relatable meme", brief: "a funny, relatable situation the audience instantly recognises" },
  how_to: { name: "How-to", brief: "clear steps to get a result" },
} as const;
export type WritingStyle = keyof typeof writingStyles;
export const writingStyleIds = Object.keys(writingStyles) as WritingStyle[];
