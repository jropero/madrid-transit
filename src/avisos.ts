import type { Alert } from './gtfs.ts';

// CRTM "Avisos" pages: rt.php (`f=crtm_avisos`) returns the page's `contAvisosInfo` block as
// HTML. One <div> per notice: a heading (h3, id = "DD_MM_YYYY Title"), a mode label paragraph
// ("Avisos Metro"), the body paragraphs and usually a "Más información..." link. Untrusted:
// parsed with DOMParser (never runs scripts), only text and one http(s) link are taken out.
export type AvisosMode = 'interurbanos' | 'metro' | 'metro-ligero';

const CRTM_ORIGIN = 'https://www.crtm.es';
const ID_DATE = /^(\d{2})_(\d{2})_(\d{4})\s/;
const MORE = /^más información/i;
const LABEL = /^avisos\b/i;

const squash = (s: string | null | undefined) => (s ?? '').replaceAll(/\s+/g, ' ').trim();

// Local midnight of the DD_MM_YYYY that starts a heading id, else null.
function idDate(id: string): Date | null {
  const m = ID_DATE.exec(id);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(d.getTime()) || d.getDate() !== Number(m[1]) ? null : d;
}

// The first link of a notice as an absolute http(s) URL, else undefined.
function firstLink(el: Element): string | undefined {
  const href = el.querySelector('a[href]')?.getAttribute('href');
  if (!href) return undefined;
  try {
    const u = new URL(href, CRTM_ORIGIN);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// Body text: the paragraphs without the mode label line and the "Más información" one.
function bodyText(el: Element): string {
  const paras = [...el.querySelectorAll('p')].map(p => squash(p.textContent)).filter(Boolean);
  const body = paras.filter((t, i) => !MORE.test(t) && !(i === 0 && LABEL.test(t)));
  return body.join(' ');
}

function toNotice(el: Element, mode: AvisosMode): Alert | null {
  const h3 = el.querySelector('h3');
  const title = squash(h3?.textContent);
  if (!h3 || !title) return null;
  const id = h3.getAttribute('id') ?? title;
  return {
    id: `crtm-${mode}-${id}`,
    routeIds: [],
    title,
    text: bodyText(el),
    from: idDate(id),
    to: null,
    url: firstLink(el),
  };
}

export function parseAvisos(html: string, mode: AvisosMode): Alert[] {
  if (typeof DOMParser === 'undefined') return [];
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root');
  const notices = [...(root?.children ?? [])].filter(e => e.tagName === 'DIV');
  return notices.flatMap(el => toNotice(el, mode) ?? []);
}

if (typeof DOMParser !== 'undefined') {
  const [a, ...rest] = parseAvisos(
    `<div><span class="d-flex"><img src=x><h3 id="28_03_2026 Suspensi&#xF3;n L10">Suspensi&#xF3;n L10</h3></span>
     <p>Avisos Metro
     <p>Desde el <strong>28 de marzo</strong><span> y hasta   fin de año.</span></p>
     <p><strong><a href="/comunicacion/x/">Más información...</a></strong></p></p></div><div></div>`,
    'metro',
  );
  console.assert(
    rest.length === 0 &&
      a?.id === 'crtm-metro-28_03_2026 Suspensión L10' &&
      a.title === 'Suspensión L10' &&
      a.text === 'Desde el 28 de marzo y hasta fin de año.' &&
      a.from?.getFullYear() === 2026 &&
      a.from.getMonth() === 2 &&
      a.from.getDate() === 28 &&
      a.url === 'https://www.crtm.es/comunicacion/x/',
    'parseAvisos reads a notice',
  );
  console.assert(
    parseAvisos('<div><h3>X</h3><a href="javascript:alert(1)">m</a></div>', 'metro')[0]?.url ===
      undefined && parseAvisos('\n  \n', 'metro').length === 0,
    'parseAvisos ignores non-http links and empty blocks',
  );
}
