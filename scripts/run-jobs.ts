/* Run the automation once from the command line (e.g. from a system cron or GitHub Actions). */
import { runAutomation } from "../src/lib/services/jobs";
import { prisma } from "../src/lib/db";

runAutomation(new Date())
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.ok ? 0 : 1;
  })
  .finally(() => prisma.$disconnect());
