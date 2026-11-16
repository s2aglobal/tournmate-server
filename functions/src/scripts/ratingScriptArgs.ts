/**
 * Shared argument handling for the ratings admin scripts. Without
 * `--project`, only tournmate-dev is allowed (the default); any other project
 * (prod, or a demo-* emulator project) must be named with --project.
 */
export interface ScriptArgs {
  projectId: string;
  apply: boolean;
  rest: Map<string, string>;
}

export function parseRatingScriptArgs(argv: string[], valueFlags: string[] = []): ScriptArgs {
  let projectId: string | undefined;
  let apply = false;
  const rest = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--project") projectId = argv[++i];
    else if (arg.startsWith("--project=")) projectId = arg.slice("--project=".length);
    else if (valueFlags.includes(arg)) rest.set(arg, argv[++i] ?? "");
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (projectId === "") {
    console.error("--project needs a value.");
    process.exit(1);
  }
  if (!projectId) {
    const env = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
    if (env && env !== "tournmate-dev") {
      console.error(`Refusing to run against ${env} from the environment. Name it explicitly: --project ${env}`);
      process.exit(1);
    }
    projectId = "tournmate-dev";
  }
  return { projectId, apply, rest };
}
