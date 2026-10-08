// Voices for talking AI creators. Public IDs only; server/voices.ts maps them to the speech provider's voices.
export const voices = [
  { id: "aria", name: "Aria", gender: "female", tone: "Warm and upbeat", accent: "American" },
  { id: "sarah", name: "Sarah", gender: "female", tone: "Soft, friendly, conversational", accent: "American" },
  { id: "jessica", name: "Jessica", gender: "female", tone: "Bright and expressive", accent: "American" },
  { id: "laura", name: "Laura", gender: "female", tone: "Quirky and energetic", accent: "American" },
  { id: "matilda", name: "Matilda", gender: "female", tone: "Calm and trustworthy", accent: "American" },
  { id: "alice", name: "Alice", gender: "female", tone: "Clear and confident", accent: "British" },
  { id: "liam", name: "Liam", gender: "male", tone: "Young and energetic", accent: "American" },
  { id: "chris", name: "Chris", gender: "male", tone: "Casual and natural", accent: "American" },
  { id: "eric", name: "Eric", gender: "male", tone: "Smooth and friendly", accent: "American" },
  { id: "brian", name: "Brian", gender: "male", tone: "Deep and reassuring", accent: "American" },
  { id: "will", name: "Will", gender: "male", tone: "Relaxed and optimistic", accent: "American" },
  { id: "george", name: "George", gender: "male", tone: "Warm storyteller", accent: "British" },
] as const;
export type VoiceId = (typeof voices)[number]["id"];
export const voiceById = (id: string) => voices.find((v) => v.id === id);
