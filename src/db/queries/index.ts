// Re-export all domain modules for the compatibility facade.
// During migration, consumers still import from "../db/queries.js".

export * from "./entries.js";
export * from "./weights.js";
export * from "./chat.js";
export * from "./observability.js";
export * from "./oura.js";
export * from "./artifacts.js";
export * from "./content-search.js";
export * from "./obsidian.js";
export * from "./usage.js";
export * from "./daily-screen-time.js";
export * from "./device-events.js";
export * from "./checkpoints.js";
export * from "./vault-fs.js";
export * from "./vocab-reviews.js";
export * from "./conjugations.js";
export * from "./conjugation-reviews.js";
export * from "./cloze-source.js";
