import { cpSync } from "node:fs";

/**
 * tsc emits JavaScript and nothing else, so the JSON the engine reads at runtime
 * (the journey config, the synthetic leads) never reaches dist on its own. Copying
 * only the directories that happen to have assets today is how leads.json got
 * missed once already, so this copies every non-TypeScript file under src.
 */
cpSync("src", "dist", {
  recursive: true,
  filter: (source) => !source.endsWith(".ts"),
});
