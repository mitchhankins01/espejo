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
