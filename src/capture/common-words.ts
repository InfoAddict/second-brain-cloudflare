/**
 * Words that tokenize to exactly one BGE (uncased BERT WordPiece) token, so the
 * token estimator may charge them 1. Every word here was checked against the
 * pinned tokenizer (test/unit/contextual-embedding.test.ts re-checks it when the
 * model cache is present). Anything not in the list is charged one token per
 * character, which is an upper bound for any text.
 */
const WORDS = `
  the of and to in a is that it was for on are as with his they at be this from have or by one had
  not but what all were when we there can an your which their said if do will each about how up out
  them then she many some so these would other into has more her two like him see time could no make
  than first been its who now people my made over did down only way find use may water long little
  very after words called just where most know get through back much before go good new write our
  used me man too any day same right look think also around another came come work three word must
  because does part even place well such here take why help put different away again off went old
  number great tell men say small every found still between name should home big give air line set
  own under read last never us left end along while might next sound below saw something thought
  both few those always looked show large often together asked house world going want school
  important until form food keep children feet land side without boy once animal life enough took
  sometimes four head above kind began almost live page got earth need far hand high year mother
  light country father let night picture being study second soon story since white ever paper hard
  near sentence better best across during today however sure knew try told young sun thing whole
  hear example heard several change answer room sea against top turned learn point city play toward
  five using himself usually money seen car morning body upon family later turn move face door cut
  done group true leave color red friend pay ask least feel fall plan free meet bring able idea fact
  real stop open cost drive run black short area walk hold remember plant table order case month
  week hour team power speak love stand rule game ship dog nothing minute begin north south east
  west class field ball less rest child add lot hot cold cool oil tree music doctor safe reason
  whether wait job price song block fine bank lose lead deep yes book mean wrote pick force voice
  type strong past level clear wide fire wall bed watch dark wind rock note age else fast per cross
  unit heat foot tall ago war gas raise trip son sat tip ten bad lost box hit dead tie bit ran fun
  arm bar aid bag ear egg eye fan fit gap gun ice key kid lap law leg lie log map mix net nod pan
  pen pet pie pin pot raw row sad sky sum tax tea toy van web win zip
`;

export const COMMON_WORDS: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean));
export const COMMON_WORD_MAX_LENGTH = Math.max(...[...COMMON_WORDS].map(w => w.length));

/**
 * Rolling 53-bit key of a run of ASCII letters, case-folded, so the estimator can
 * look a word up without allocating a substring: feed each letter's code, then
 * read `key`. Two independent 32-bit mixes make a false match between an unlisted
 * run and a listed word about 1 in 10^15.
 */
export class WordKey {
  private a = 2166136261;
  private b = 5381;
  add(code: number): void {
    const lc = code | 32;
    this.a = Math.imul(this.a ^ lc, 16777619);
    this.b = Math.imul(this.b, 33) + lc | 0;
  }
  get key(): number {
    return (this.a >>> 0) * 2097152 + (this.b >>> 11);
  }
  reset(): void {
    this.a = 2166136261;
    this.b = 5381;
  }
}

const keyOf = (word: string): number => {
  const k = new WordKey();
  for (let i = 0; i < word.length; i++) k.add(word.charCodeAt(i));
  return k.key;
};

/** Keys of COMMON_WORDS; a run counts as one token only when its key is here. */
export const COMMON_WORD_KEYS: ReadonlySet<number> = new Set([...COMMON_WORDS].map(keyOf));
