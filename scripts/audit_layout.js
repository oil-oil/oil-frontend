/**
 * Universal browser DOM geometry & layout-overflow audit (zero dependencies).
 *
 * Usage:
 * - Browser console / ego-browser eval / Playwright page.evaluate:
 *     Inject this file directly; it returns the audit report object and also
 *     attaches `globalThis.__oilAuditLayout(options)` for repeated calls.
 * - Options:
 *     {
 *       maxIssues?: number,         // default 60
 *       includeWarnings?: boolean,  // default true
 *       rootSelector?: string,      // default 'body'
 *       minOverlapPx?: number,      // default 3
 *     }
 */
(function (globalScope) {
  'use strict';

  const CONTROL_SELECTOR = [
    'button',
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    'summary',
    'label',
    'nav a',
    'header a',
  ].join(',');

  const TEXT_CONTAINER_IGNORE = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'SVG',
    'PATH',
    'G',
    'DEFS',
    'IFRAME',
    'CANVAS',
    'VIDEO',
    'AUDIO',
    'IMG',
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'OPTION',
    'BR',
    'HR',
  ]);

  function normalizeText(raw) {
    return (raw || '').replace(/\s+/g, ' ').trim();
  }

  function shortText(raw, limit = 48) {
    const t = normalizeText(raw);
    return t.length > limit ? t.slice(0, limit - 1) + '…' : t;
  }

  function cssSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.body && depth < 4) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }
      const classes = Array.from(cur.classList || [])
        .filter((c) => c && !/^(hover|focus|active|js-)/.test(c) && c.length < 36)
        .slice(0, 2);
      if (classes.length) {
        part += '.' + classes.map((c) => CSS.escape(c)).join('.');
      } else if (cur.getAttribute('role')) {
        part += `[role="${cur.getAttribute('role')}"]`;
      }
      if (cur.parentElement) {
        const sameTag = Array.from(cur.parentElement.children).filter(
          (sib) => sib.tagName === cur.tagName
        );
        if (sameTag.length > 1) {
          part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function isVisuallyHiddenStyle(style, rect) {
    if (!style) return true;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return true;
    }
    if (parseFloat(style.opacity) === 0) return true;
    if (rect.width < 2 || rect.height < 2) return true;
    if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)') {
      return true;
    }
    return false;
  }

  function isIgnoredSubtree(el) {
    // Skip collapsed <details> body (everything inside <details> except <summary>)
    const closedDetails = el.closest && el.closest('details:not([open])');
    if (closedDetails && !el.closest('summary')) return true;

    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.hasAttribute('data-layout-audit-ignore')) return true;
      if (cur.getAttribute('aria-hidden') === 'true') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function isElementVisible(el, styleCache) {
    if (!el || el.nodeType !== 1) return false;
    if (isIgnoredSubtree(el)) return false;
    const rect = el.getBoundingClientRect();
    const style = getStyle(el, styleCache);
    if (isVisuallyHiddenStyle(style, rect)) return false;
    // Skip elements completely outside the document (e.g. offscreen left/top tabs or portals)
    if (rect.right <= 0 || rect.bottom <= 0) return false;
    // Check ancestors for display:none / opacity:0 / collapsed 0x0 clip
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const ps = getStyle(p, styleCache);
      if (ps.display === 'none' || ps.visibility === 'hidden' || parseFloat(ps.opacity) === 0) {
        return false;
      }
      const ox = ps.overflowX;
      const oy = ps.overflowY;
      if (ox === 'hidden' || ox === 'clip' || oy === 'hidden' || oy === 'clip') {
        const pr = p.getBoundingClientRect();
        if (pr.width < 2 || pr.height < 2) return false;
        // Completely outside an ancestor clip box (e.g. inactive carousel slide or scrolled-out list row)
        if (
          rect.right <= pr.left + 1 ||
          rect.left >= pr.right - 1 ||
          rect.bottom <= pr.top + 1 ||
          rect.top >= pr.bottom - 1
        ) {
          return false;
        }
      }
      p = p.parentElement;
    }
    return true;
  }

  function getStyle(el, cache) {
    let s = cache.get(el);
    if (!s) {
      s = window.getComputedStyle(el);
      cache.set(el, s);
    }
    return s;
  }

  function isDynamicPathOrLongValue(text) {
    if (!text) return false;
    if (text.length > 36) return true;
    if (/^[A-Za-z]:\\/.test(text) || /^\/[\w.-]+\//.test(text) || /^https?:\/\//.test(text)) {
      return true;
    }
    return false;
  }

  function hasExplicitLineClamp(style) {
    const lc = style.webkitLineClamp || style.lineClamp;
    return Boolean(lc && lc !== 'none' && lc !== 'normal' && parseInt(lc, 10) > 0);
  }

  function isScrollableAxis(overflowValue) {
    return overflowValue === 'auto' || overflowValue === 'scroll';
  }

  function isClippingAxis(overflowValue) {
    return overflowValue === 'hidden' || overflowValue === 'clip';
  }

  function directTextNodes(el) {
    const nodes = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 3 && normalizeText(child.nodeValue).length > 0) {
        nodes.push(child);
      }
    }
    return nodes;
  }

  function measureTextRange(textNode) {
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    const bounding = range.getBoundingClientRect();
    range.detach && range.detach();
    // Count distinct visual line boxes (group rects whose vertical midpoints are within 4px)
    const lines = [];
    for (const r of rects) {
      const midY = (r.top + r.bottom) / 2;
      if (!lines.some((y) => Math.abs(y - midY) <= 4)) {
        lines.push(midY);
      }
    }
    return { bounding, lineCount: lines.length, rects };
  }

  function hasNegativeMargin(style) {
    return (
      parseFloat(style.marginLeft) < -0.5 ||
      parseFloat(style.marginRight) < -0.5 ||
      parseFloat(style.marginTop) < -0.5 ||
      parseFloat(style.marginBottom) < -0.5
    );
  }

  function hasNonZeroTransform(style) {
    return Boolean(style.transform && style.transform !== 'none');
  }

  function sameGridCell(styleA, styleB) {
    // Detect CSS Grid intentional overlay (both items explicitly pinned to same row & column)
    const explicit = (v) => v && v !== 'auto';
    if (
      explicit(styleA.gridRowStart) &&
      explicit(styleA.gridColumnStart) &&
      styleA.gridRowStart === styleB.gridRowStart &&
      styleA.gridColumnStart === styleB.gridColumnStart
    ) {
      return true;
    }
    return false;
  }

  function auditLayout(options = {}) {
    const maxIssues = options.maxIssues ?? 60;
    const includeWarnings = options.includeWarnings ?? true;
    const minOverlapPx = options.minOverlapPx ?? 3;
    const root = options.rootSelector
      ? document.querySelector(options.rootSelector)
      : document.body;

    if (!root) {
      return {
        ok: false,
        error: `Root element not found: ${options.rootSelector}`,
        issues: [],
      };
    }

    const styleCache = new WeakMap();
    const issues = [];
    const seenKeys = new Set();

    function pushIssue(issue) {
      if (!includeWarnings && issue.severity === 'warn') return;
      const key = `${issue.kind}|${issue.selector}|${issue.detailKey || ''}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      delete issue.detailKey;
      issues.push(issue);
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    // 1. Page-level accidental horizontal overflow
    const docEl = document.documentElement;
    const docStyle = getStyle(docEl, styleCache);
    const bodyStyle = document.body ? getStyle(document.body, styleCache) : docStyle;
    const pageOverflowX = docEl.scrollWidth - vw;
    if (
      pageOverflowX > 2 &&
      !isClippingAxis(docStyle.overflowX) &&
      !isClippingAxis(bodyStyle.overflowX)
    ) {
      const culprits = [];
      for (const el of root.querySelectorAll('*')) {
        if (TEXT_CONTAINER_IGNORE.has(el.tagName)) continue;
        if (!isElementVisible(el, styleCache)) continue;
        const r = el.getBoundingClientRect();
        if (r.right > vw + 2 && r.width < docEl.scrollWidth) {
          // Prefer leaf-ish culprits rather than full-width wrappers
          const childExceeds = Array.from(el.children).some(
            (c) => c.getBoundingClientRect().right > vw + 2
          );
          if (!childExceeds) {
            culprits.push({
              selector: cssSelector(el),
              right: Math.round(r.right),
              overflowPx: Math.round(r.right - vw),
              text: shortText(el.textContent, 30),
            });
          }
        }
        if (culprits.length >= 5) break;
      }
      pushIssue({
        kind: 'page-horizontal-overflow',
        severity: 'error',
        selector: 'html',
        text: '',
        metrics: {
          scrollWidth: docEl.scrollWidth,
          viewportWidth: vw,
          overflowPx: Math.round(pageOverflowX),
          culprits,
        },
        hint: 'Eliminate fixed widths exceeding viewport or add min-width: 0 / flex-wrap on wide rows.',
      });
    }

    const allElements = Array.from(root.querySelectorAll('*'));

    // 2, 3, 4. Element-level text clipping, vertical clipping, and unexpected control wrapping
    for (const el of allElements) {
      if (issues.length >= maxIssues * 2) break;
      if (TEXT_CONTAINER_IGNORE.has(el.tagName)) continue;
      if (!isElementVisible(el, styleCache)) continue;

      const style = getStyle(el, styleCache);
      const rect = el.getBoundingClientRect();
      const isControl = el.matches(CONTROL_SELECTOR);
      const text = normalizeText(el.textContent);
      const directTexts = directTextNodes(el);
      const hasTooltip = Boolean(
        el.getAttribute('title') ||
          el.getAttribute('aria-label') ||
          el.closest('[title]')
      );

      // 2. Horizontal overflow / truncation on controls & clipped text elements
      if (text.length >= 2 && !isScrollableAxis(style.overflowX)) {
        const overflowX = el.scrollWidth - el.clientWidth;
        const hasEllipsis = style.textOverflow === 'ellipsis';
        const clipsX = isClippingAxis(style.overflowX);

        // Also catch centered/overflow-visible text sticking outside a fixed-width control box
        let rangeOverflowX = 0;
        if (isControl) {
          const padL = parseFloat(style.paddingLeft) || 0;
          const padR = parseFloat(style.paddingRight) || 0;
          const innerLeft = rect.left + Math.min(padL, 2);
          const innerRight = rect.right - Math.min(padR, 2);
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let tn;
          while ((tn = walker.nextNode())) {
            if (!normalizeText(tn.nodeValue)) continue;
            const pe = tn.parentElement;
            if (!pe || !isElementVisible(pe, styleCache)) continue;
            const tr = measureTextRange(tn).bounding;
            if (tr.width < 1) continue;
            rangeOverflowX = Math.max(
              rangeOverflowX,
              innerLeft - tr.left,
              tr.right - innerRight
            );
          }
        }

        const effectiveOverflowX = Math.max(overflowX, rangeOverflowX);
        if (effectiveOverflowX > 1.5 && (clipsX || isControl)) {
          const isLeafOrControl =
            isControl ||
            directTexts.length > 0 ||
            el.children.length === 0;

          if (isLeafOrControl) {
            // Avoid double-reporting both outer button and its sole inner label span
            const insideControl = !isControl && Boolean(el.closest(CONTROL_SELECTOR));
            const dynamicAllowed = hasEllipsis && isDynamicPathOrLongValue(text) && hasTooltip;

            if (!dynamicAllowed) {
              if (isControl || insideControl) {
                const controlEl = isControl ? el : el.closest(CONTROL_SELECTOR);
                const controlRect = controlEl.getBoundingClientRect();
                const controlText = normalizeText(controlEl.textContent);
                const isCardButton =
                  !isControl &&
                  hasEllipsis &&
                  (controlRect.height > 64 || controlEl.querySelectorAll('div, p, h1, h2, h3, h4').length >= 2);

                if (isCardButton) {
                  if (!hasTooltip && text.length > 8) {
                    pushIssue({
                      kind: 'truncated-without-tooltip',
                      severity: 'warn',
                      selector: cssSelector(el),
                      text: shortText(text),
                      metrics: {
                        clientWidth: Math.round(el.clientWidth),
                        scrollWidth: Math.round(el.scrollWidth),
                        overflowPx: Math.round(overflowX),
                      },
                      hint: 'Card title/metadata is truncated; add title tooltip so full name remains inspectable.',
                    });
                  }
                } else if (!(hasEllipsis && isDynamicPathOrLongValue(controlText) && hasTooltip)) {
                  pushIssue({
                    kind: 'control-text-clipped',
                    severity: 'error',
                    selector: cssSelector(controlEl),
                    detailKey: cssSelector(controlEl),
                    text: shortText(controlText),
                    metrics: {
                      clientWidth: Math.round(el.clientWidth),
                      scrollWidth: Math.round(Math.max(el.scrollWidth, el.clientWidth + rangeOverflowX)),
                      overflowPx: Math.round(effectiveOverflowX),
                      textOverflow: style.textOverflow,
                      fontWeight: style.fontWeight,
                    },
                    hint: 'Avoid hardcoded narrow width on controls; let content expand, allow wrap, or reserve bold/i18n width.',
                  });
                }
              } else if (clipsX && !hasEllipsis) {
                pushIssue({
                  kind: 'text-hard-clipped-x',
                  severity: 'error',
                  selector: cssSelector(el),
                  text: shortText(text),
                  metrics: {
                    clientWidth: Math.round(el.clientWidth),
                    scrollWidth: Math.round(el.scrollWidth),
                    overflowPx: Math.round(overflowX),
                  },
                  hint: 'Use flex: 1; min-width: 0 with explicit ellipsis + title, or allow wrapping.',
                });
              } else if (clipsX && hasEllipsis && !hasTooltip && text.length > 8) {
                pushIssue({
                  kind: 'truncated-without-tooltip',
                  severity: 'warn',
                  selector: cssSelector(el),
                  text: shortText(text),
                  metrics: {
                    clientWidth: Math.round(el.clientWidth),
                    scrollWidth: Math.round(el.scrollWidth),
                    overflowPx: Math.round(overflowX),
                  },
                  hint: 'Truncated identifying text should expose full content (e.g. title tooltip or expandable layout).',
                });
              }
            }
          }
        }
      }

      // 3. Vertical text clipping or text bleeding out of an under-sized fixed-height box
      if (
        directTexts.length > 0 &&
        !isScrollableAxis(style.overflowY) &&
        !hasExplicitLineClamp(style)
      ) {
        const clipsY = isClippingAxis(style.overflowY);
        const overflowY = el.scrollHeight - el.clientHeight;
        let glyphClipPx = 0;
        let textHeight = 0;
        for (const tn of directTexts) {
          const { bounding } = measureTextRange(tn);
          if (bounding.height < 1) continue;
          textHeight = Math.max(textHeight, bounding.height);
          const topClip = rect.top - bounding.top;
          const bottomClip = bounding.bottom - rect.bottom;
          glyphClipPx = Math.max(glyphClipPx, topClip, bottomClip);
        }
        const fontSize = parseFloat(style.fontSize) || 12;
        const severelyShortHeight =
          clipsY && rect.height > 0 && rect.height < fontSize * 1.05 && overflowY >= 2;

        if ((clipsY && overflowY >= 3) || (clipsY && glyphClipPx > 2) || severelyShortHeight) {
          pushIssue({
            kind: 'vertical-text-clip',
            severity: 'error',
            selector: cssSelector(el),
            text: shortText(text),
            metrics: {
              clientHeight: Math.round(el.clientHeight),
              scrollHeight: Math.round(el.scrollHeight),
              overflowPx: Math.round(Math.max(overflowY, glyphClipPx)),
              fontSize: Math.round(fontSize),
            },
            hint: 'Replace fixed height with min-height and center via Flex/Grid (align-items: center) instead of fixed height/line-height.',
          });
        } else if (
          el.parentElement &&
          el.parentElement !== document.body &&
          textHeight > 0
        ) {
          // Catch fixed-height parent (e.g. `.recent-heading { height: 14px }`) shorter than child text
          const pEl = el.parentElement;
          const pStyle = getStyle(pEl, styleCache);
          const pRect = pEl.getBoundingClientRect();
          if (
            !isScrollableAxis(pStyle.overflowY) &&
            !hasExplicitLineClamp(pStyle) &&
            pRect.height > 2 &&
            pRect.height < textHeight - 2
          ) {
            pushIssue({
              kind: 'vertical-text-clip',
              severity: isClippingAxis(pStyle.overflowY) ? 'error' : 'warn',
              selector: cssSelector(pEl),
              detailKey: `parent-y|${cssSelector(pEl)}`,
              text: shortText(text),
              metrics: {
                parentHeight: Math.round(pRect.height),
                textHeight: Math.round(textHeight),
                overflowPx: Math.round(textHeight - pRect.height),
                parentOverflowY: pStyle.overflowY,
              },
              hint: 'Parent row height is shorter than rendered text; replace fixed height with min-height and Flex align-items: center.',
            });
          }
        }
      }

      // 4. Short control text unexpectedly wrapping onto 2+ lines
      if (
        isControl &&
        text.length >= 2 &&
        text.length <= 28 &&
        !el.textContent.includes('\n') &&
        style.whiteSpace !== 'nowrap' &&
        style.whiteSpace !== 'pre'
      ) {
        // Check leaf text nodes inside control (ignores stacked icon + single-line label)
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        let wrappedLineCount = 1;
        let wrappedSample = '';
        while ((node = walker.nextNode())) {
          const t = normalizeText(node.nodeValue);
          if (t.length < 4 || t.length > 28) continue;
          const parentEl = node.parentElement;
          if (!parentEl || !isElementVisible(parentEl, styleCache)) continue;
          const { lineCount } = measureTextRange(node);
          if (lineCount >= 2) {
            wrappedLineCount = Math.max(wrappedLineCount, lineCount);
            wrappedSample = t;
            break;
          }
        }
        // Only flag controls that are clearly compact buttons/tabs/nav items (not large multi-line cards)
        if (wrappedLineCount >= 2 && rect.height < 96 && rect.width < 260) {
          pushIssue({
            kind: 'control-unexpected-wrap',
            severity: 'warn',
            selector: cssSelector(el),
            text: shortText(wrappedSample || text),
            metrics: {
              lines: wrappedLineCount,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            hint: 'Compact control label wrapped onto multiple lines; widen container, allow parent row flex-wrap, or add flex-shrink: 0.',
          });
        }
      }

      // 5. Flex / Grid sibling overlap detection
      const display = style.display;
      if (
        display === 'flex' ||
        display === 'inline-flex' ||
        display === 'grid' ||
        display === 'inline-grid'
      ) {
        const isGrid = display.includes('grid');
        const children = Array.from(el.children).filter((child) => {
          if (TEXT_CONTAINER_IGNORE.has(child.tagName)) return false;
          if (!isElementVisible(child, styleCache)) return false;
          const cs = getStyle(child, styleCache);
          if (cs.position === 'absolute' || cs.position === 'fixed') return false;
          if (cs.pointerEvents === 'none') return false;
          if (hasNegativeMargin(cs) || hasNonZeroTransform(cs)) return false;
          const r = child.getBoundingClientRect();
          return r.width >= 4 && r.height >= 4;
        });

        // Pairwise check capped for very large grids (e.g. virtualized/gallery lists)
        const limit = Math.min(children.length, 40);
        const childBounds = children.slice(0, limit).map((child) => {
          const r = child.getBoundingClientRect();
          const cs = getStyle(child, styleCache);
          // Expand effective right/bottom if overflow-visible text bleeds past child's own box
          let right = r.right;
          let bottom = r.bottom;
          if (!isClippingAxis(cs.overflowX) && !isScrollableAxis(cs.overflowX) && child.scrollWidth > child.clientWidth + 2) {
            right = Math.max(right, r.left + child.scrollWidth);
          }
          if (!isClippingAxis(cs.overflowY) && !isScrollableAxis(cs.overflowY) && child.scrollHeight > child.clientHeight + 2) {
            bottom = Math.max(bottom, r.top + child.scrollHeight);
          }
          return { el: child, style: cs, rect: { left: r.left, top: r.top, right, bottom, width: right - r.left, height: bottom - r.top } };
        });

        for (let i = 0; i < childBounds.length; i++) {
          const a = childBounds[i];
          for (let j = i + 1; j < childBounds.length; j++) {
            const b = childBounds[j];
            if (isGrid && sameGridCell(a.style, b.style)) continue;
            const ox = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
            const oy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
            if (ox > minOverlapPx && oy > minOverlapPx) {
              const overlapArea = ox * oy;
              const minArea = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
              if (overlapArea >= 16 && overlapArea / Math.max(minArea, 1) >= 0.12) {
                pushIssue({
                  kind: 'sibling-overlap',
                  severity: 'error',
                  selector: cssSelector(el),
                  detailKey: `${cssSelector(a.el)}<>${cssSelector(b.el)}`,
                  text: `${shortText(a.el.textContent, 20)} ∩ ${shortText(b.el.textContent, 20)}`,
                  metrics: {
                    overlapW: Math.round(ox),
                    overlapH: Math.round(oy),
                    first: cssSelector(a.el),
                    second: cssSelector(b.el),
                  },
                  hint: 'Siblings overlap in Flex/Grid; add gap, min-width: 0 on flexible items, flex-shrink: 0 on controls, or flex-wrap.',
                });
              }
            }
          }
        }
      }

      // 6. Child partially clipped by a non-scrollable clipping ancestor
      if (isControl && rect.width >= 8 && rect.height >= 8) {
        let anc = el.parentElement;
        let hops = 0;
        while (anc && anc !== document.body && hops < 6) {
          const as = getStyle(anc, styleCache);
          // Stop if control sits inside an intentional horizontal scroll container
          if (isScrollableAxis(as.overflowX)) break;
          if (isClippingAxis(as.overflowX)) {
            const ar = anc.getBoundingClientRect();
            const sticksRight = rect.right > ar.right + 2 && rect.left < ar.right - 2;
            const sticksLeft = rect.left < ar.left - 2 && rect.right > ar.left + 2;
            if ((sticksRight || sticksLeft) && !hasNonZeroTransform(style)) {
              pushIssue({
                kind: 'parent-clip-overflow',
                severity: 'error',
                selector: cssSelector(el),
                detailKey: `x|${cssSelector(anc)}`,
                text: shortText(text),
                metrics: {
                  clippedBy: cssSelector(anc),
                  clipPx: Math.round(
                    Math.max(rect.right - ar.right, ar.left - rect.left)
                  ),
                },
                hint: 'Control extends beyond clipping parent; check parent fixed width, flex-wrap, or min-width: 0 on siblings.',
              });
              break;
            }
          }
          anc = anc.parentElement;
          hops += 1;
        }
      }
    }

    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warn');

    return {
      ok: errors.length === 0,
      url: location.href,
      viewport: { width: vw, height: vh, dpr },
      summary: {
        errors: errors.length,
        warnings: warnings.length,
        total: issues.length,
        byKind: issues.reduce((acc, item) => {
          acc[item.kind] = (acc[item.kind] || 0) + 1;
          return acc;
        }, {}),
      },
      issues: issues.slice(0, maxIssues),
    };
  }

  globalScope.__oilAuditLayout = auditLayout;

  // Return report directly when evaluated via page.evaluate / DevTools / ego-browser eval.
  return auditLayout();
})(typeof globalThis !== 'undefined' ? globalThis : window);
