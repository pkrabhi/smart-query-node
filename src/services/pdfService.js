'use strict';
/**
 * pdfService.js — KMC Smart Query PDF Report Generator v6
 * ─────────────────────────────────────────────────────────
 *  • Auto portrait / landscape based on column count
 *  • KMC logo in header (loads from resources/assets/kmc_logo.png)
 *  • Diagonal watermark on every page
 *  • Data-driven column widths (P90 heuristic)
 *  • Numeric right-aligned, text left-aligned
 *  • Headers wrap to 3 lines for narrow columns
 *  • SQL appendix with syntax highlighting
 *  • Professional KMC navy/gold theme
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs   = require('fs');

// ── Convert question to a meaningful filename slug ───────
const STOP_WORDS = new Set([
    'what','how','many','show','me','get','list','find','give','display','fetch',
    'all','the','a','an','of','in','for','to','with','and','or','is','are',
    'was','were','be','been','have','has','had','do','does','did','will','would',
    'could','should','that','this','these','those','from','by','on','at','as',
    'into','during','before','after','between','each','every','some','no','not',
    'where','which','who','when','why','per','its','their','our','my','your',
]);

function questionToSlug(question, maxWords = 6) {
    const words = question
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1 && !STOP_WORDS.has(w))
        .slice(0, maxWords)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1));
    return words.length > 0 ? words.join('_') : 'Report';
}

// ── Asset paths ──────────────────────────────────────────
//    Accepts any of these filenames (jpg or png, with/without suffix)
const ASSETS_DIR = path.join(__dirname, '../resources/assets');
const LOGO_PATH = (
    ['kmcblue.jpg', 'kmcblue.png', 'kmc_logo.jpg', 'kmc_logo.png',
     'kmcbluewater.jpg', 'kmcbluewater.png']
        .map(f => path.join(ASSETS_DIR, f))
        .find(p => fs.existsSync(p))
) || null;
const LOGO_EXISTS = !!LOGO_PATH;

// ── Brand palette ─────────────────────────────────────────
const C = {
    // Header / top bar
    hdrDark:     '#0D1B4B',   // very dark navy
    hdrMid:      '#1A237E',   // deep indigo
    hdrLight:    '#283593',   // medium indigo
    hdrAccent:   '#F9A825',   // gold accent stripe
    // Column headers
    colHdrBg:    '#1E3A8A',   // rich blue
    colHdrFg:    '#FFFFFF',
    colHdrDiv:   '#3B5FC0',   // divider between col headers
    // Data rows
    rowEven:     '#FFFFFF',
    rowOdd:      '#F0F4FF',   // very light lavender
    rowHover:    '#E8ECFF',
    // Cell text
    txtDark:     '#1A1A2E',
    txtNum:      '#0D1B4B',   // numbers in navy
    txtNull:     '#BDBDBD',
    txtRowNum:   '#94A3B8',
    // Grid
    gridH:       '#E2E8F0',
    gridV:       '#CBD5E1',
    gridBorder:  '#94A3B8',
    // Meta card
    metaBg:      '#F8FAFF',
    metaBorder:  '#C7D7F0',
    metaLabel:   '#1E3A8A',
    metaValue:   '#1A1A2E',
    // Misc
    accentLine:  '#F9A825',
    footerTxt:   '#94A3B8',
    sqlBg:       '#F8FAFF',
    sqlKw:       '#1A237E',
    sqlStr:      '#1565C0',
    white:       '#FFFFFF',
    watermark:   '#1A237E',   // deep navy for watermark (dark enough to show at low opacity)
    subTxt:      '#90A4AE',
};

// ── Page dimensions (all in points) ──────────────────────
//    PDFKit size = [WIDTH, HEIGHT]
const PAGES = {
    A4_P:  { w: 595.28,  h: 841.89,  label: 'A4 Portrait',  orient: 'portrait'  },
    A4_L:  { w: 841.89,  h: 595.28,  label: 'A4 Landscape', orient: 'landscape' },
    A3_L:  { w: 1190.55, h: 841.89,  label: 'A3 Landscape', orient: 'landscape' },
    A2_L:  { w: 1683.78, h: 1190.55, label: 'A2 Landscape', orient: 'landscape' },
};

const MARGIN    = 36;
const HEADER_H  = 95;   // KMC letterhead height
const FOOTER_H  = 24;
const ROW_NUM_W = 28;

// ── Auto orientation + page selection ────────────────────
function choosePage(colCount) {
    if (colCount <= 4)  return PAGES.A4_P;   // portrait: 1–4 cols
    if (colCount <= 8)  return PAGES.A4_L;   // landscape A4: 5–8
    if (colCount <= 16) return PAGES.A3_L;   // landscape A3: 9–16
    if (colCount <= 24) return PAGES.A2_L;   // landscape A2: 17–24
    return PAGES.A3_L;                        // 25+ → chunked on A3
}

// ── Font/row tiers ────────────────────────────────────────
function getTier(colCount, orient) {
    const isPortrait = orient === 'portrait';
    if (isPortrait) {
        if (colCount <= 2) return { title:18, sub:10, meta:9, th:8,  td:8,  foot:7,  rowH:17, hdrLines:1 };
        if (colCount <= 4) return { title:16, sub:9,  meta:8, th:7,  td:7,  foot:6.5,rowH:15, hdrLines:2 };
        return                    { title:14, sub:8,  meta:7, th:6.5,td:6.5,foot:6,  rowH:13, hdrLines:2 };
    }
    if (colCount <= 6)  return { title:16, sub:10, meta:9, th:8,   td:8,   foot:7,  rowH:17, hdrLines:1 };
    if (colCount <= 10) return { title:14, sub:9,  meta:8, th:7,   td:7,   foot:6.5,rowH:15, hdrLines:2 };
    if (colCount <= 16) return { title:13, sub:8,  meta:7, th:6.5, td:6.5, foot:6,  rowH:13, hdrLines:2 };
    if (colCount <= 22) return { title:11, sub:7,  meta:6, th:6,   td:6,   foot:5.5,rowH:12, hdrLines:3 };
    return                    { title:10, sub:6,  meta:6, th:5.5, td:5.5, foot:5,  rowH:11, hdrLines:3 };
}

// ── Column chunking (25+ columns) ─────────────────────────
function splitColumns(columns) {
    if (columns.length <= 24) return [columns.map((_, i) => i)];
    const chunks = [];
    const rest = columns.slice(1).map((_, i) => i + 1);
    for (let i = 0; i < rest.length; i += 15) {
        chunks.push([0, ...rest.slice(i, i + 15)]);
    }
    return chunks;
}

// ── Numeric detection ─────────────────────────────────────
function isNumCol(col, data) {
    let num = 0, total = 0;
    for (const row of data.slice(0, 50)) {
        const v = row[col];
        if (v == null) continue;
        total++;
        if (!isNaN(Number(String(v))) && String(v).trim() !== '') num++;
    }
    return total > 0 && num / total > 0.7;
}

// ── Data-driven column width computation ──────────────────
function computeColumnWidths(columns, data, availW, tier) {
    if (!columns.length) return [];
    const sample  = data.slice(0, 120);
    const charW   = tier.td * 0.52;
    const pad     = 6;

    const raw = columns.map(col => {
        let maxLen = 0, sumLen = 0, n = 0;
        for (const row of sample) {
            const v = row[col];
            if (v == null) continue;
            const l = String(v).length;
            maxLen = Math.max(maxLen, l);
            sumLen += l; n++;
        }
        const avg  = n > 0 ? sumLen / n : 2;
        const data90 = n > 0 ? Math.min(avg * 1.5 + 1, maxLen, 32) : 3;
        // Header can wrap — effective header width per line
        const hdrPerLine = col.length / tier.hdrLines;
        return Math.max(data90, hdrPerLine * 0.65, 3);
    });

    const totalRaw = raw.reduce((a, b) => a + b, 0);
    const AVAIL    = availW - ROW_NUM_W;
    const MIN_W    = Math.max(charW * 3 + pad, 20);
    const MAX_W    = AVAIL * 0.28;

    let widths = raw.map(s => (s / totalRaw) * AVAIL);
    widths = widths.map(w => Math.min(MAX_W, Math.max(MIN_W, w)));

    // Rescale to fit exactly
    const sum   = widths.reduce((a, b) => a + b, 0);
    const scale = AVAIL / sum;
    widths = widths.map(w => Math.round(w * scale));
    widths[widths.length - 1] += AVAIL - widths.reduce((a, b) => a + b, 0);
    return widths;
}

// ── Truncate text to fit column ───────────────────────────
function trunc(str, widthPt, fs) {
    const charW  = (fs || 7) * 0.52;
    const maxLen = Math.max(Math.floor(widthPt / charW), 2);
    if (str.length <= maxLen) return str;
    return str.slice(0, Math.max(maxLen - 1, 1)) + '…';
}

// ═══════════════════════════════════════════════════════════
//  MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════
function generatePdf(res, opts) {
    const {
        question        = '',
        moduleCode      = 'MARKET',
        queryId         = 'N/A',
        source          = 'NVIDIA NIM',
        generatedSql    = '',
        executionTimeMs = 0,
        columns         = [],
        data            = [],
    } = opts;

    const colCount  = columns.length;
    const totalRows = data.length;
    const page      = choosePage(colCount);
    const PW        = page.w;    // WIDTH  (correct: PDFKit [w, h])
    const PH        = page.h;    // HEIGHT
    const CW        = PW - MARGIN * 2;
    const tier      = getTier(colCount, page.orient);
    const ROW_H     = tier.rowH;
    const COL_HDR_H = tier.th * tier.hdrLines + 12;
    const chunks    = splitColumns(columns);

    const now     = new Date();
    const dateStr = now.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric', timeZone:'Asia/Kolkata' });
    const timeStr = now.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kolkata' });
    const modLabel  = moduleCode === 'MARKET' ? 'Market Module' : moduleCode === 'ENGINEERING' ? 'Engineering Module' : moduleCode;
    const deptLabel = moduleCode === 'MARKET' ? 'MARKET DEPARTMENT' : moduleCode === 'ENGINEERING' ? 'ENGINEERING DEPARTMENT' : 'MUNICIPAL DEPARTMENT';

    // Numeric flags (cached)
    const numFlags = {};
    for (const col of columns) numFlags[col] = isNumCol(col, data);

    // Usable body area per page
    const bodyH      = PH - HEADER_H - FOOTER_H - MARGIN * 2;
    const rowsPerPg  = Math.max(Math.floor((bodyH - COL_HDR_H) / ROW_H), 1);
    const dataPages  = Math.max(Math.ceil(totalRows / rowsPerPg), 1);
    let   totalPages = dataPages * chunks.length;

    // ── Create document ──────────────────────────────────
    const doc = new PDFDocument({
        size:     [PW, PH],          // ← FIXED: [WIDTH, HEIGHT]
        margins:  { top: 0, bottom: 0, left: 0, right: 0 },  // We manage layout manually
        info: {
            Title:   `KMC Smart Query — ${question.slice(0, 80)}`,
            Author:  'KMC Smart Query AI',
            Creator: 'KMC Smart Query v6.0',
            Subject: `${modLabel} Report`,
        },
        autoFirstPage: false,
        compress: true,
    });

    const slug     = questionToSlug(question || queryId || 'Report');
    const date     = now.toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `KMC_${slug}_${date}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    let pageNum = 0;

    // ── Add a page ───────────────────────────────────────
    function newPage() {
        pageNum++;
        doc.addPage({ size: [PW, PH] });
        // Disable PDFKit's automatic page-break detection — we handle all breaks manually.
        // Without this, text drawn at y > (PH - default_margin=72) triggers phantom pages.
        doc.page.margins.bottom = 0;
        doc.page.margins.top    = 0;
        _drawHeader(doc, deptLabel, PW, tier);
        _drawWatermark(doc, PW, PH);
        _drawFooter(doc, pageNum, totalPages, PW, PH, CW, tier);
        return HEADER_H + MARGIN;
    }

    // ── Render each column chunk ─────────────────────────
    for (let ci = 0; ci < chunks.length; ci++) {
        const idxs     = chunks[ci];
        const chunkCols = idxs.map(i => columns[i]);
        const chunkData = data.map(row => {
            const o = {};
            for (const i of idxs) o[columns[i]] = row[columns[i]];
            return o;
        });
        const colWidths = computeColumnWidths(chunkCols, chunkData, CW, tier);

        let y = newPage();

        // Report title — first page only
        if (ci === 0) {
            y = _drawReportTitle(doc, y, question, CW, tier);
        }

        if (chunks.length > 1) {
            doc.fontSize(tier.meta).font('Helvetica-Bold').fillColor(C.metaLabel)
               .text(`Column Group ${ci + 1} of ${chunks.length}`, MARGIN, y);
            y += 14;
        }

        // Draw data table
        y = _drawTable(doc, y, chunkCols, chunkData, colWidths, numFlags, {
            newPage, breakAt: PH - FOOTER_H - MARGIN - 4,
            tier, COL_HDR_H, ROW_H, CW, PW, PH,
        });
    }

    doc.end();
}

// ═══════════════════════════════════════════════════════════
//  HEADER — KMC official letterhead style
// ═══════════════════════════════════════════════════════════
function _drawHeader(doc, deptLabel, PW, tier) {
    const H = HEADER_H;

    // White background
    doc.rect(0, 0, PW, H).fill('#FFFFFF');

    // Navy top border line
    doc.rect(0, 0, PW, 3).fill(C.hdrDark);

    // Gold bottom stripe
    doc.rect(0, H - 3, PW, 3).fill(C.hdrAccent);
    // Navy line just above gold
    doc.rect(0, H - 5, PW, 2).fill(C.hdrDark);

    // ── KMC Logo (left-aligned, vertically centered) ──────
    const LOGO_SIZE = 78;
    const LOGO_X    = MARGIN;
    const LOGO_Y    = (H - 5 - LOGO_SIZE) / 2 + 3;

    if (LOGO_EXISTS) {
        try {
            doc.image(LOGO_PATH, LOGO_X, LOGO_Y, {
                width:  LOGO_SIZE,
                height: LOGO_SIZE,
                fit:    [LOGO_SIZE, LOGO_SIZE],
                align:  'center',
                valign: 'center',
            });
        } catch (_) {
            _drawLogoFallback(doc, LOGO_X, LOGO_Y, LOGO_SIZE);
        }
    } else {
        _drawLogoFallback(doc, LOGO_X, LOGO_Y, LOGO_SIZE);
    }

    // ── Centered text block (full page width) ─────────────
    let ty = 8;

    doc.fontSize(13.5).font('Helvetica-Bold').fillColor(C.hdrDark)
       .text('THE KOLKATA MUNICIPAL CORPORATION', 0, ty, { width: PW, align: 'center' });
    ty += 19;

    doc.fontSize(10.5).font('Helvetica-Bold').fillColor(C.hdrDark)
       .text(deptLabel, 0, ty, { width: PW, align: 'center' });
    ty += 15;

    doc.fontSize(8.5).font('Helvetica').fillColor(C.hdrDark)
       .text('5, S.N BANERJEE ROAD, KOLKATA-700013, West Bengal', 0, ty, { width: PW, align: 'center' });
    ty += 12;

    doc.fontSize(8.5).font('Helvetica').fillColor(C.hdrDark)
       .text('PHONE : (033)-22861058', 0, ty, { width: PW, align: 'center' });
    ty += 12;

    doc.fontSize(7.5).font('Helvetica').fillColor('#444444')
       .text(
           'PLACE OF SERVICE: KOLKATA, SAC-00440406, STATE CODE: 19, GSTN NO: 19AAALT1025G1Z6',
           0, ty, { width: PW, align: 'center' }
       );
}

// ── Logo text fallback (when PNG missing) ─────────────────
function _drawLogoFallback(doc, x, y, size) {
    doc.circle(x + size / 2, y + size / 2, size / 2 - 2)
       .strokeColor(C.hdrDark).lineWidth(1.5).stroke();
    doc.fontSize(Math.round(size * 0.14)).font('Helvetica-Bold').fillColor(C.hdrDark)
       .text('KMC', x, y + size / 2 - size * 0.09, { width: size, align: 'center' });
    doc.fontSize(Math.round(size * 0.075)).font('Helvetica').fillColor(C.hdrDark)
       .text('KOLKATA', x, y + size / 2 + size * 0.06, { width: size, align: 'center' });
}

// ═══════════════════════════════════════════════════════════
//  REPORT TITLE — centered question text after letterhead
// ═══════════════════════════════════════════════════════════
function _drawReportTitle(doc, y, question, CW, tier) {
    const PAD = 10;
    const reportName = question.length > 130 ? question.slice(0, 128) + '…' : question;

    // Top accent line
    doc.rect(MARGIN, y, CW, 1.5).fill(C.hdrAccent);
    y += PAD;

    doc.fontSize(tier.sub + 2).font('Helvetica-Bold').fillColor(C.hdrDark)
       .text(reportName, MARGIN, y, { width: CW, align: 'center' });

    y += tier.sub + 2 + PAD + 4;

    // Bottom separator line
    doc.rect(MARGIN, y, CW, 0.75).fill(C.metaBorder);
    y += 10;

    return y;
}

// ═══════════════════════════════════════════════════════════
//  WATERMARK — diagonal text centered across every page
// ═══════════════════════════════════════════════════════════
function _drawWatermark(doc, PW, PH) {
    doc.save();

    // Use a span wide enough to fill the whole rotated page
    const SPAN = Math.sqrt(PW * PW + PH * PH); // page diagonal = safe full-width

    // Center on page, rotate -38°
    const cx = PW / 2;
    const cy = PH / 2;
    doc.translate(cx, cy).rotate(-38);

    // Font sizes — scale with page size so watermark fills landscape/A3 too
    const fs1 = Math.round(Math.min(PW, PH) * 0.085);  // ~50pt for A4 portrait
    const fs2 = Math.round(Math.min(PW, PH) * 0.072);  // ~43pt for A4 portrait

    // Line gap: half the larger font, so the two lines sit symmetrically around 0
    const lineGap = fs1 * 0.6;

    doc.font('Helvetica-Bold').fillColor(C.watermark).fillOpacity(0.13);

    // Line 1 — "KOLKATA MUNICIPAL" centered above the page center
    doc.fontSize(fs1)
       .text('KOLKATA MUNICIPAL', -SPAN / 2, -lineGap - fs1 * 0.5, {
           width:            SPAN,
           align:            'center',
           characterSpacing: 3,
           lineBreak:        false,
       });

    // Line 2 — "CORPORATION" centered below the page center
    doc.fontSize(fs2)
       .text('CORPORATION', -SPAN / 2, lineGap * 0.2, {
           width:            SPAN,
           align:            'center',
           characterSpacing: 5,
           lineBreak:        false,
       });

    doc.restore();
    doc.fillOpacity(1); // reset opacity
}

// ═══════════════════════════════════════════════════════════
//  FOOTER
// ═══════════════════════════════════════════════════════════
function _drawFooter(doc, pageNum, totalPages, PW, PH, CW, tier) {
    const FY = PH - MARGIN - FOOTER_H + 6;

    // Footer line
    doc.rect(MARGIN, FY - 4, CW, 0.5).fill(C.hdrAccent);

    doc.fontSize(tier.foot || 6.5).font('Helvetica').fillColor(C.footerTxt)
       .text(
           'KMC Smart Query AI  ·  Kolkata Municipal Corporation  ·  CONFIDENTIAL',
           MARGIN, FY, { width: CW - 80 }
       );

    doc.fontSize(tier.foot || 6.5).font('Helvetica-Bold').fillColor(C.metaLabel)
       .text(`Page ${pageNum} of ${totalPages}`, MARGIN, FY, { width: CW, align: 'right' });
}

// ═══════════════════════════════════════════════════════════
//  META CARD — query info summary
// ═══════════════════════════════════════════════════════════
function _drawMeta(doc, y, m, CW, tier) {
    const H   = 58;
    const PAD = 10;

    // Card shadow effect (subtle)
    doc.rect(MARGIN + 1, y + 1, CW, H)
       .fill('#E2E8F0');

    // Card fill
    doc.rect(MARGIN, y, CW, H).fill(C.metaBg);

    // Left accent bar
    doc.rect(MARGIN, y, 4, H).fill(C.hdrAccent);

    // Card border
    doc.rect(MARGIN, y, CW, H)
       .strokeColor(C.metaBorder).lineWidth(0.5).stroke();

    // Question text
    const qShort = m.question.length > 160 ? m.question.slice(0, 158) + '…' : m.question;
    doc.fontSize(tier.meta + 0.5)
       .font('Helvetica-Bold').fillColor(C.metaLabel)
       .text('QUERY  ', MARGIN + PAD + 4, y + PAD, { continued: true })
       .font('Helvetica').fillColor(C.metaValue)
       .text(qShort, { width: CW - PAD * 2 - 8, lineBreak: false });

    // Pills row
    const PY = y + PAD + 18;
    const pills = [
        ['MODULE',   m.modLabel],
        ['QUERY ID', m.queryId],
        ['ROWS',     m.totalRows.toLocaleString()],
        ['COLUMNS',  String(m.colCount)],
        ['TIME',     `${m.executionTimeMs}ms`],
        ['PAGE',     m.pageLabel],
        ['SOURCE',   m.source],
    ];

    const spacing = CW / pills.length;
    let   px      = MARGIN + PAD;
    const fs      = Math.max(tier.foot - 0.5, 5);

    for (const [lbl, val] of pills) {
        // Pill background
        const pw = spacing - 4;
        doc.rect(px - 2, PY - 2, pw, 14)
           .fill('#EEF2FF')
           .strokeColor(C.metaBorder).lineWidth(0.3).stroke();

        doc.fontSize(fs - 0.5).font('Helvetica-Bold').fillColor(C.metaLabel)
           .text(lbl, px, PY, { width: pw - 4, align: 'center' });
        doc.fontSize(fs).font('Helvetica-Bold').fillColor(C.metaValue)
           .text(val, px, PY + 6, { width: pw - 4, align: 'center' });

        px += spacing;
        if (px > MARGIN + CW - 30) break;
    }

    return y + H + 10;
}

// ═══════════════════════════════════════════════════════════
//  TABLE
// ═══════════════════════════════════════════════════════════
function _drawTable(doc, startY, columns, data, colWidths, numFlags, opts) {
    const { newPage, breakAt, tier, COL_HDR_H, ROW_H, CW } = opts;
    const TL = MARGIN;
    let y = startY;

    function drawColHeader(atY) {
        // Column header background
        doc.rect(TL, atY, CW, COL_HDR_H).fill(C.colHdrBg);

        // Row number label
        doc.fontSize(tier.th - 0.5).font('Helvetica-Bold').fillColor('#7F9CF5')
           .text('#', TL + 1, atY + (COL_HDR_H - tier.th) / 2 + 1,
                 { width: ROW_NUM_W - 3, align: 'center' });

        // Row num divider
        doc.moveTo(TL + ROW_NUM_W, atY + 2)
           .lineTo(TL + ROW_NUM_W, atY + COL_HDR_H - 2)
           .strokeColor(C.colHdrDiv).lineWidth(0.5).stroke();

        let x = TL + ROW_NUM_W;
        for (let i = 0; i < columns.length; i++) {
            const w     = colWidths[i];
            const label = columns[i].replace(/_/g, ' ').toUpperCase();

            doc.fontSize(tier.th).font('Helvetica-Bold').fillColor(C.colHdrFg)
               .text(label, x + 3, atY + 4, {
                   width:   w - 6,
                   height:  COL_HDR_H - 6,
                   ellipsis: true,
                   lineGap:  0.5,
                   align:    numFlags[columns[i]] ? 'right' : 'left',
               });

            // Vertical divider
            if (i < columns.length - 1) {
                doc.moveTo(x + w, atY + 4)
                   .lineTo(x + w, atY + COL_HDR_H - 4)
                   .strokeColor(C.colHdrDiv).lineWidth(0.4).stroke();
            }
            x += w;
        }

        // Bottom accent line
        doc.rect(TL, atY + COL_HDR_H - 1.5, CW, 1.5).fill(C.hdrAccent);

        return atY + COL_HDR_H;
    }

    y = drawColHeader(y);
    const tableTopY = startY;

    // ── Data rows ─────────────────────────────────────────
    for (let ri = 0; ri < data.length; ri++) {

        if (y + ROW_H > breakAt) {
            // Close current page's table border
            doc.rect(TL, tableTopY, CW, y - tableTopY)
               .strokeColor(C.gridBorder).lineWidth(0.5).stroke();
            y = newPage();
            y = drawColHeader(y);
        }

        const row = data[ri];
        const odd = ri % 2 === 1;

        // Row background
        doc.rect(TL, y, CW, ROW_H).fill(odd ? C.rowOdd : C.rowEven);

        // Horizontal rule
        doc.moveTo(TL, y + ROW_H)
           .lineTo(TL + CW, y + ROW_H)
           .strokeColor(C.gridH).lineWidth(0.25).stroke();

        // Row number
        doc.fontSize(tier.td - 0.5).font('Helvetica').fillColor(C.txtRowNum)
           .text(String(ri + 1), TL + 1, y + (ROW_H - tier.td) / 2 + 1,
                 { width: ROW_NUM_W - 3, align: 'right' });

        doc.moveTo(TL + ROW_NUM_W, y)
           .lineTo(TL + ROW_NUM_W, y + ROW_H)
           .strokeColor(C.gridH).lineWidth(0.2).stroke();

        // Cells
        let x = TL + ROW_NUM_W;
        for (let ci = 0; ci < columns.length; ci++) {
            const col    = columns[ci];
            const raw    = row[col];
            const w      = colWidths[ci];
            const isNull = raw == null;
            const isNum  = !isNull && numFlags[col];
            const str    = isNull ? 'null' : String(raw);

            doc.fontSize(tier.td)
               .font(isNum ? 'Helvetica-Bold' : 'Helvetica')
               .fillColor(isNull ? C.txtNull : isNum ? C.txtNum : C.txtDark)
               .text(
                   trunc(str, w - 6, tier.td),
                   x + 3,
                   y + (ROW_H - tier.td) / 2 + 0.5,
                   { width: w - 6, ellipsis: true, align: isNum ? 'right' : 'left' }
               );

            if (ci < columns.length - 1) {
                doc.moveTo(x + w, y)
                   .lineTo(x + w, y + ROW_H)
                   .strokeColor(C.gridV).lineWidth(0.2).stroke();
            }
            x += w;
        }

        y += ROW_H;
    }

    // ── Table outer border ────────────────────────────────
    doc.rect(TL, tableTopY, CW, y - tableTopY)
       .strokeColor(C.gridBorder).lineWidth(0.6).stroke();

    // ── Summary row ───────────────────────────────────────
    y += 6;
    doc.rect(TL, y, CW, 14).fill('#EEF2FF');
    doc.fontSize(tier.meta || 7).font('Helvetica').fillColor(C.metaLabel)
       .text(
           `  ${data.length.toLocaleString()} record${data.length !== 1 ? 's' : ''}  ·  ${columns.length} column${columns.length !== 1 ? 's' : ''}`,
           TL, y + 2, { width: CW / 2 }
       );
    doc.font('Helvetica-Bold').fillColor(C.hdrMid)
       .text('END OF DATA', TL, y + 2, { width: CW - 6, align: 'right' });
    doc.rect(TL, y, CW, 14).strokeColor(C.gridBorder).lineWidth(0.4).stroke();

    return y + 20;
}

// ═══════════════════════════════════════════════════════════
//  SQL APPENDIX
// ═══════════════════════════════════════════════════════════
function _drawSqlPage(doc, y, sql, CW, PH, tier) {
    const sf    = Math.max(tier.td, 6.5);
    const lineH = sf + 3.5;

    // Title
    doc.fontSize(tier.sub + 1).font('Helvetica-Bold').fillColor(C.hdrMid)
       .text('Appendix — Generated SQL', MARGIN, y);

    doc.rect(MARGIN, y + 14, CW, 2).fill(C.hdrAccent);
    y += 22;

    const lines    = sql.split('\n');
    const maxBoxH  = PH - y - MARGIN - FOOTER_H - 20;
    const contentH = Math.min(lines.length * lineH + 20, maxBoxH);

    // Code block background + border
    doc.rect(MARGIN, y, CW, contentH)
       .fill(C.sqlBg)
       .strokeColor(C.gridBorder).lineWidth(0.5).stroke();

    // Left gutter for line numbers
    const gutW = 30;
    doc.rect(MARGIN, y, gutW, contentH).fill('#EEF2FF');
    doc.moveTo(MARGIN + gutW, y).lineTo(MARGIN + gutW, y + contentH)
       .strokeColor(C.metaBorder).lineWidth(0.5).stroke();

    // SQL keywords for syntax highlighting
    const KW_RE = /^(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|GROUP|ORDER|HAVING|LIMIT|OFFSET|WITH|AND|OR|ON|AS|CASE|WHEN|THEN|ELSE|END|UNION|DISTINCT|COUNT|SUM|AVG|MIN|MAX|COALESCE|CAST|BETWEEN|IN|NOT|EXISTS|LIKE|IS|NULL|ASC|DESC|BY|SET|INTO|SCHEMA)\b/i;

    let ly = y + 8;
    let shown = 0;
    for (let i = 0; i < lines.length; i++) {
        if (ly > y + contentH - 10) break;

        // Line number
        doc.fontSize(sf - 1).font('Helvetica').fillColor(C.footerTxt)
           .text(String(i + 1), MARGIN + 2, ly, { width: gutW - 4, align: 'right' });

        const line    = lines[i];
        const trimmed = line.trim();
        const isKw    = KW_RE.test(trimmed);
        const isComment = trimmed.startsWith('--');

        doc.fontSize(sf)
           .font(isKw ? 'Helvetica-Bold' : 'Helvetica')
           .fillColor(isComment ? C.footerTxt : isKw ? C.sqlKw : C.txtDark)
           .text(
               trunc(line, CW - gutW - 14, sf),
               MARGIN + gutW + 6, ly,
               { width: CW - gutW - 12 }
           );

        ly += lineH;
        shown++;
    }

    if (lines.length > shown) {
        doc.fontSize(sf - 1).font('Helvetica').fillColor(C.footerTxt)
           .text(`… ${lines.length - shown} more lines`, MARGIN + gutW + 6, y + contentH - 10);
    }
}

module.exports = { generatePdf };
