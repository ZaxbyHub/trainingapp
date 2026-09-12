// Per-slide text walk for Storyline slide payloads (issue #77, G3).
//
// Document order is slideLayers[] then objects[] in array order. Each object
// contributes, in order:
//   1. data.vectorData.altText — only when a NON-EMPTY string ("" and null both
//      occur corpus-wide; videodata.altText is a media FILENAME and is never
//      collected);
//   2. object.textLib[].vartext.blocks[].spans[].text — spans concatenated per
//      textLib entry (all 1960 corpus vartext entries are this dict-blocks form;
//      textdata.altText does not exist — 0 of 1960 entries carry an altText key —
//      so it is intentionally not consulted).
// %player.<var>% tokens are stripped from every piece before assembly; pieces
// that are empty after stripping are dropped (an all-empty slide yields
// onScreenText '' / textChars 0, never a crash or a stray newline).

type Rec = Record<string, unknown>;

const PLAYER_TOKEN = /%player\.[A-Za-z0-9_.]+%/g;

function asRecord(value: unknown): Rec {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Rec;
  }
  throw new Error(`expected an object, got ${value === null ? 'null' : typeof value}`);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error(`expected an array, got ${typeof value}`);
}

function optRecord(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function vartextText(vartext: Rec): string {
  let out = '';
  const blocks = asArray(vartext['blocks']);
  for (const block of blocks) {
    const spans = asArray(asRecord(block)['spans']);
    for (const span of spans) {
      const text = asRecord(span)['text'];
      if (typeof text === 'string') out += text;
    }
  }
  return out;
}

export function walkSlideText(slidePayload: object): {
  onScreenText: string;
  textChars: number;
} {
  const slide = asRecord(slidePayload);
  const layers = asArray(slide['slideLayers']);
  const pieces: string[] = [];
  const push = (piece: string): void => {
    const stripped = piece.replace(PLAYER_TOKEN, '');
    if (stripped.length > 0) pieces.push(stripped);
  };
  for (const layer of layers) {
    const objects = asArray(asRecord(layer)['objects']);
    for (const object of objects) {
      const obj = asRecord(object);
      const data = optRecord(obj['data']);
      const vectorData = data === undefined ? undefined : optRecord(data['vectorData']);
      const altText = vectorData === undefined ? undefined : vectorData['altText'];
      if (typeof altText === 'string') push(altText);
      const textLib = obj['textLib'];
      if (Array.isArray(textLib)) {
        for (const entry of textLib) {
          const vartext = optRecord(asRecord(entry)['vartext']);
          if (vartext !== undefined) push(vartextText(vartext));
        }
      }
    }
  }
  const onScreenText = pieces.join('\n');
  return { onScreenText, textChars: onScreenText.length };
}
