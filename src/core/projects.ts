import fs from 'node:fs';
import path from 'node:path';

/** Folder (inside the directory LocalLoom was started in) that holds every generated project. */
export const PROJECTS_DIR_NAME = 'LocalLoom Projects';

const FILLER = new Set(
  `a an the me us my our your i we you it this that these those please pls plz can could would will should want need like
   to of some new simple basic small little quick nice good cool great working fully full complete whole just now then also
   make create build write develop generate scaffold code design implement start setup set up give do let lets
   hey hi hello bro yo ok okay so and`.split(/\s+/),
);

/** Words after which the request describes *how*, not *what* ("… in python using tkinter"). */
const CUT = new Set(['in', 'using', 'with', 'that', 'which', 'where', 'for', 'by', 'on', 'from', 'via', 'based', 'written', 'so', 'when']);

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A short, filesystem-safe folder name derived from the request, e.g. "calculator-app". */
export function projectNameFor(task: string): string {
  const words = task
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const kept: string[] = [];
  for (const w of words) {
    if (CUT.has(w) && kept.length) break;
    if (FILLER.has(w) || CUT.has(w)) continue;
    kept.push(w);
    if (kept.length === 4) break;
  }
  let name = kept.join('-').slice(0, 48).replace(/-+$/, '');
  if (!name || RESERVED.test(name)) name = name ? `${name}-project` : 'project';
  return name;
}

/** Create a fresh folder for a project; a taken name gets a " (1)", " (2)", … suffix. */
export function createProjectDir(root: string, name: string): { name: string; dir: string } {
  fs.mkdirSync(root, { recursive: true });
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${name} (${n})`;
    const dir = path.join(root, candidate);
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir);
    return { name: candidate, dir };
  }
}

const NEW_PROJECT =
  /\b(make|create|build|write|develop|generate|scaffold|code|design|start)\s+(?:(?:me|us)\s+)?(?:a\s+new|an?|another|new|one\s+more)\s+((?:\S+\s*){1,6})/i;
/** Things that are a part of a project rather than a project. */
const PART =
  /\b(file|function|class|method|button|tests?|folder|directory|component|page|route|endpoint|field|variable|readme|comment|feature|option|menu|label|screen|section|module|column|row|check|test case)\b/i;

/** Does this request ask for a brand-new project (as opposed to changing the current one)? */
export function looksLikeNewProject(task: string): boolean {
  const m = NEW_PROJECT.exec(task);
  return !!m && !PART.test(m[2]!);
}

/** Remove a project folder only if nothing was put in it. */
export function removeIfEmpty(dir: string): boolean {
  try {
    if (fs.readdirSync(dir).length) return false;
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}
