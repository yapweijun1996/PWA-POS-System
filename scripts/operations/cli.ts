import { createBackup } from "./backup-create.ts";
import { restoreBackup } from "./backup-restore.ts";
import { releaseCheck } from "./release-check.ts";
import { secret } from "./secrets.ts";

try {
  switch (process.argv[2]) {
    case "backup":
      await createBackup();
      break;
    case "restore":
      await restoreBackup();
      break;
    case "release-check":
      await releaseCheck();
      break;
    case "migrate": {
      const { migrate } = await import("../migrate.ts");
      await migrate((await secret("DATABASE_URL"))!);
      console.log("Reviewed migrations applied");
      break;
    }
    case "setup": {
      process.env.DATABASE_URL = (await secret("DATABASE_URL"))!;
      process.env.SETUP_PASSWORD = (await secret("SETUP_PASSWORD"))!;
      await import("../setup.ts");
      delete process.env.SETUP_PASSWORD;
      break;
    }
    default:
      console.log(
        "Commands: backup | restore | release-check | migrate | setup. See docs/runbooks/production.md.",
      );
      if (process.argv[2] && process.argv[2] !== "help") process.exitCode = 1;
  }
} catch (error) {
  // PostgreSQL errors can include connection details or row contents.
  const message =
    error instanceof Error && !("severity" in error)
      ? error.message
      : `Operation failed (${String((error as { code?: string }).code ?? "DATABASE_ERROR")}); inspect privately (database diagnostics withheld)`;
  console.error(message);
  process.exitCode = 1;
}
