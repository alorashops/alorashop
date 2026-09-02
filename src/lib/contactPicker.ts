/**
 * Contact-picking helpers for the "New Customer" form.
 *
 * There is NO single web API that can read the phone's address book on every
 * platform, so this module adapts per runtime:
 *
 *  - Android (Chrome / Chromium PVAs, secure context): the native Contacts
 *    Picker API (`navigator.contacts.select`) — the user picks from their real
 *    address book and we get name + phone back directly.
 *  - iOS (Safari, incl. standalone PWA) and desktop (Windows/macOS): the web
 *    has no contacts access, but a hidden `<input type="file" accept="vCard">`
 *    makes iOS surface a "Contacts" section in the system document picker and
 *    hands us the chosen contact's `.vcf`, which we parse (FN + best TEL).
 *
 * Every call resolves a DISCRIMINATED RESULT and never throws, so the caller
 * can show the exact right message (picked / canceled / unsupported / failed)
 * instead of leaving an unhandled rejection or a silent no-op.
 */

export type ContactPick =
  | { ok: true; name: string; tel: string }
  | { ok: false; reason: 'unavailable' | 'canceled' | 'failed'; message?: string };

/** Minimal shape of `navigator.contacts` — declared locally so we don't depend
 *  on a specific TypeScript lib.dom version shipping these types or not. */
interface ContactsManagerShim {
  select(
    properties: string[],
    options: { multiple: boolean }
  ): Promise<Array<{ name?: string; tel?: string[] }>>;
}

type NavigatorWithContacts = Navigator & { contacts?: ContactsManagerShim };

/** True only where the native Contacts Picker API exists (Android Chrome). */
export function isContactPickerSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'contacts' in navigator &&
    typeof (navigator as NavigatorWithContacts).contacts?.select === 'function'
  );
}

/**
 * Android path: open the system contact chooser and return the selected
 * contact's phone (plus name, to pre-fill the form). The user dismissing the
 * picker or denying the permission prompt is a normal "no thanks" — surfaced
 * as `canceled`, not an error.
 */
export async function pickPhoneContact(): Promise<ContactPick> {
  const cm = (navigator as NavigatorWithContacts).contacts;
  if (!cm) return { ok: false, reason: 'unavailable' };

  try {
    const [contact] = await cm.select(['name', 'tel'], { multiple: false });
    if (!contact) return { ok: false, reason: 'canceled' };

    const name = (contact.name ?? '').trim();
    const phone = (Array.isArray(contact.tel) && contact.tel.length > 0 ? contact.tel[0] : '').trim();
    if (!phone) {
      return { ok: false, reason: 'canceled', message: 'That contact has no phone number.' };
    }
    return { ok: true, name, tel: compactPhone(phone) };
  } catch (err) {
    // NotAllowedError covers both dismissing the picker and denying the
    // contacts permission prompt — both are graceful cancels. Everything else
    // (SecurityError, AbortError, missing Google Play Services on Chrome
    // Android, a property the browser doesn't support) is a real failure.
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      return { ok: false, reason: 'canceled' };
    }
    return { ok: false, reason: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * iOS / desktop path: import a `.vcf` via the system file picker. On iOS the
 * document picker shows a "Contacts" section (iOS feeds the tapped contact's
 * vCard through the same input). Cancel detection uses the window-refocus
 * signal (the picker sheet closing returns focus), with a long backstop timer
 * so the promise can never hang forever on any engine.
 */
export function pickVCardContact(): Promise<ContactPick> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: ContactPick) => {
      if (done) return;
      done = true;
      clearTimeout(backstop);
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(r);
    };

    const onFocus = () => {
      // Focus returned without a change event → the sheet was dismissed.
      setTimeout(() => finish({ ok: false, reason: 'canceled' }), 300);
    };

    // Hard backstop: never leave the caller hanging on any engine. The
    // focus-based cancel fires in well under a second on iOS/Android; this is
    // the safety net for desktop engines that don't blur/refocus the window.
    const backstop = setTimeout(() => finish({ ok: false, reason: 'canceled' }), 60_000);

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'text/vcard,.vcf,text/x-vcard';
    input.style.display = 'none';

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        finish({ ok: false, reason: 'canceled' });
        return;
      }
      void file
        .text()
        .then((text) => {
          const parsed = parseVCard(text);
          if (!parsed) {
            finish({ ok: false, reason: 'canceled', message: 'That file contains no contact with a phone number.' });
            return;
          }
          finish({ ok: true, name: parsed.name, tel: parsed.tel });
        })
        .catch(() => finish({ ok: false, reason: 'failed', message: 'Could not read the contact file.' }));
    };

    // When the system picker opens, the window blurs; when it closes (with no
    // file chosen) focus returns — that's our reliable "canceled" signal.
    input.onclick = () => {
      window.addEventListener('focus', onFocus, { once: true });
    };

    document.body.appendChild(input);
    input.click();
  });
}

/** Compact a contact phone so it stores/search-matches like a typed number. */
function compactPhone(phone: string): string {
  return phone.replace(/[\s()\-./]/g, '').trim();
}

// ---------------------------------------------------------------------------
// vCard parsing (RFC 2426 / 2.1)
// ---------------------------------------------------------------------------
export interface VCardContact {
  name: string;
  tel: string;
}

interface TelCandidate {
  value: string;
  mobile: boolean;
  pref: boolean;
}

/** Pull the best contact out of `.vcf` text: FN/N for the name, preferred or
 *  mobile TEL for the phone. Returns `null` when nothing usable is found. */
export function parseVCard(raw: string): VCardContact | null {
  // vCards fold long lines: continuation lines start with a space or tab.
  const unfolded = raw.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/).map((l) => l.trim());

  let inCard = false;
  let currentName = '';
  let currentTels: TelCandidate[] = [];
  let best: VCardContact | null = null;

  const flushCard = () => {
    if (!inCard) return;
    const tel = pickBestTel(currentTels);
    if (tel && !best) best = { name: currentName, tel };
    currentName = '';
    currentTels = [];
    inCard = false;
  };

  for (const line of lines) {
    if (!line) continue;
    if (/^BEGIN:VCARD$/i.test(line)) {
      flushCard();
      inCard = true;
      continue;
    }
    if (/^END:VCARD$/i.test(line)) {
      flushCard();
      continue;
    }
    if (!inCard) continue;

        // property[;params]:value — vCard 2.1 may also use `TEL;CELL:...`.
    // Note: the no-params form has only two groups, so read the value from the
    // match that actually succeeded (the 2-group fallback puts value in [2]).
    const withParams = line.match(/^([^:;]+);([^:]*):(.*)$/);
    const bits = withParams ?? line.match(/^([^:;]+):(.*)$/);
    if (!bits) continue;
    const property = bits[1].toUpperCase();
    const params = withParams ? withParams[2] : '';
    const value = withParams ? withParams[3] : bits[2];

    if (property === 'FN' && !currentName) {
      currentName = decodeVCardValue(value).trim();
    } else if (property === 'N' && !currentName) {
      // N:Family;Given;Middle;Prefix;Suffix — present the given name first.
      const parts = value.split(';');
      const given = (parts[1] ?? '').trim();
      const family = (parts[0] ?? '').trim();
      currentName = decodeVCardValue([given, family].filter(Boolean).join(' ')).trim();
    } else if (property === 'TEL') {
      let tel = value.trim();
      if (tel.toLowerCase().startsWith('tel:')) tel = tel.slice(4);
      tel = compactPhone(tel);
      if (tel) {
        const lower = params.toLowerCase();
        currentTels.push({
          value: tel,
          mobile: /(cell|mobile|voice)/.test(lower),
          pref: lower.includes('pref')
        });
      }
    }
  }
  // Flush the last card even if the file lacked BEGIN/END wrappers.
  flushCard();
  return best;
}

function pickBestTel(tels: TelCandidate[]): string | undefined {
  if (tels.length === 0) return undefined;
  return (tels.find((t) => t.pref) ?? tels.find((t) => t.mobile) ?? tels[0]).value;
}

/** Decode quoted-printable vCard values (vCard 2.1 names) as UTF-8 bytes. */
function decodeQp(s: string): string {
  const bytes: number[] = [];
  let i = 0;
  while (i < s.length) {
    const hex = s.slice(i + 1, i + 3);
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 3;
    } else {
      bytes.push(s.charCodeAt(i));
      i += 1;
    }
  }
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

/** Only bother decoding when the value actually contains QP escapes. */
function decodeVCardValue(value: string): string {
  return /=[0-9A-Fa-f]{2}/.test(value) ? decodeQp(value) : value;
}