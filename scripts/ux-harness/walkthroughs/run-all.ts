import { journeys } from "./journeys";
import { runJourneys } from "./runner";

runJourneys(journeys).then((results) => {
  process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
