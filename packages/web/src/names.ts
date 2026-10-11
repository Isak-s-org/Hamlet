// Villager names. A session's name comes from a hash of its id, so it is the same after a reload,
// and once given it is kept while the page lives, even if another bot would now want it.
const NAMES: Record<string, string[]> = {
  stone: ["Ugo", "Ara", "Brak", "Tok", "Nuna", "Grok", "Ayla", "Orn", "Kesh", "Mog", "Zug", "Thra", "Una", "Boro", "Ika", "Rok", "Vala", "Duru", "Esk", "Fen", "Gora", "Hask", "Ilo", "Juk", "Kaa", "Lom", "Mira", "Nok", "Oda", "Pell", "Rasa", "Sko", "Tala", "Ulf", "Vek", "Wren", "Yara", "Zoka", "Bram", "Dag"],
  suburb: ["Linda", "Gary", "Doug", "Patty", "Steve", "Barb", "Ron", "Deb", "Kevin", "Tammy", "Greg", "Sheila", "Rick", "Cindy", "Dave", "Sue", "Phil", "Joan", "Hank", "Peggy", "Walt", "Marge", "Bob", "Carol", "Frank", "Diane", "Ted", "Lois", "Ned", "Rita", "Earl", "Pam", "Stan", "Gail", "Mike", "Judy", "Lou", "Nancy", "Bud", "Wendy"],
  japan: ["Haruto", "Yui", "Sota", "Hina", "Ren", "Aoi", "Kaito", "Mei", "Riku", "Sakura", "Yuto", "Rin", "Haru", "Mio", "Sora", "Koharu", "Daiki", "Emi", "Kenji", "Nao", "Taro", "Yuna", "Shin", "Aki", "Kenta", "Hana", "Ryo", "Saki", "Takumi", "Miyu", "Jun", "Kaede", "Itsuki", "Rina", "Hayato", "Yuki", "Asahi", "Noa", "Kota", "Tsubasa"],
};

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const given = new Map<string, string>();
let givenFor = "";

/** Names for the live sessions in this world. A clash moves the newcomer to the next free name. */
export function nameAll(sessionIds: string[], world: string): Map<string, string> {
  const list = NAMES[world] ?? NAMES.stone!;
  if (givenFor !== world) given.clear(), (givenFor = world);
  const live = new Set(sessionIds);
  for (const id of given.keys()) if (!live.has(id)) given.delete(id);
  const taken = new Set(given.values());
  for (const id of sessionIds) {
    if (given.has(id)) continue;
    const start = hash(id);
    let name = "";
    for (let i = 0; i < list.length && !name; i++) {
      const n = list[(start + i) % list.length]!;
      if (!taken.has(n)) name = n;
    }
    // More bots than names: reuse the hashed one with a number.
    for (let k = 2; !name; k++) if (!taken.has(`${list[start % list.length]} ${k}`)) name = `${list[start % list.length]} ${k}`;
    given.set(id, name);
    taken.add(name);
  }
  return given;
}
