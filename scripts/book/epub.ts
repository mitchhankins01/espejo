import { writeFile } from "fs/promises";
import { EPub } from "epub-gen-memory";
import { marked } from "marked";
import { splitTomo } from "./writer.js";

export interface EpubOptions {
  tomoNum: number;
  title: string;
  markdown: string;
  outPath: string;
}

const SERIES_NAME = "Espejo";

export async function buildEpub(opts: EpubOptions): Promise<void> {
  const { tomoNum, title, markdown, outPath } = opts;

  const { body, takeaways } = splitTomo(markdown);
  const bodyHtml = await marked.parse(body);

  // Strip the "## Para llevarte" heading line — the chapter title supplies it.
  const takeawaysBody = takeaways.replace(/^##\s+Para llevarte\s*\n?/m, "").trim();
  const takeawaysHtml = takeawaysBody ? await marked.parse(takeawaysBody) : "";

  const padded = String(tomoNum).padStart(4, "0");
  const bookTitle = `${SERIES_NAME} — Tomo ${padded} — ${title}`;

  const chapters = [
    {
      title,
      content: bodyHtml,
    },
  ];
  if (takeawaysHtml) {
    chapters.push({
      title: "Para llevarte",
      content: takeawaysHtml,
    });
  }
  // Trailing colophon chapter — gives Kindle a definite "next page" target so
  // swiping past the last takeaway triggers the end-of-book read marker instead
  // of stalling at 100%.
  chapters.push({
    title: "Fin",
    content: colophonHtml(tomoNum, title),
  });

  const epub = new EPub(
    {
      title: bookTitle,
      author: SERIES_NAME,
      lang: "es",
      description: `Tomo ${tomoNum} — ${title}`,
      tocTitle: "Índice",
      contentOPF: opfTemplate(tomoNum),
    },
    chapters
  );

  const buffer = await epub.genEpub();
  await writeFile(outPath, buffer);
}

export function tomoFilename(tomoNum: number, title: string): string {
  const padded = String(tomoNum).padStart(4, "0");
  const slug = slugify(title);
  return `Espejo Tomo ${padded} - ${slug}.epub`;
}

function colophonHtml(tomoNum: number, title: string): string {
  const padded = String(tomoNum).padStart(4, "0");
  const safeTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return [
    `<div style="text-align: center; margin-top: 40%;">`,
    `<p style="font-size: 1.4em; letter-spacing: 0.2em;">~ Fin ~</p>`,
    `<p style="margin-top: 2em; font-style: italic;">${SERIES_NAME} · Tomo ${padded}</p>`,
    `<p style="font-style: italic;">${safeTitle}</p>`,
    `</div>`,
  ].join("\n");
}

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
}

// Custom OPF template, derived from epub-gen-memory's epub3 default with
// Calibre-style series metadata + EPUB3 belongs-to-collection injected so
// Kindle groups personal-doc tomos into a single series collection.
function opfTemplate(tomoNum: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf"
         version="3.0"
         unique-identifier="BookId"
         xmlns:dc="http://purl.org/dc/elements/1.1/"
         xmlns:dcterms="http://purl.org/dc/terms/"
         xml:lang="en"
         xmlns:media="http://www.idpf.org/epub/vocab/overlays/#"
         prefix="ibooks: http://vocabulary.itunes.apple.com/rdf/ibooks/vocabulary-extensions-1.0/">

    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"
              xmlns:opf="http://www.idpf.org/2007/opf">

        <dc:identifier id="BookId"><%= id %></dc:identifier>
        <meta refines="#BookId" property="identifier-type" scheme="onix:codelist5">22</meta>
        <meta property="dcterms:identifier" id="meta-identifier">BookId</meta>
        <dc:title><%= title %></dc:title>
        <meta property="dcterms:title" id="meta-title"><%= title %></meta>
        <dc:description><%= description %></dc:description>
        <dc:language><%= lang %></dc:language>
        <meta property="dcterms:language" id="meta-language"><%= lang %></meta>
        <meta property="dcterms:modified"><%= (new Date()).toISOString().split(".")[0]+ "Z" %></meta>
        <dc:creator id="creator"><%= author.join(",") %></dc:creator>
        <meta refines="#creator" property="file-as"><%= author.join(",") %></meta>
        <meta property="dcterms:publisher"><%= publisher %></meta>
        <dc:publisher><%= publisher %></dc:publisher>
        <meta property="dcterms:date"><%= date %></meta>
        <dc:date><%= date %></dc:date>
        <meta property="dcterms:rights">All rights reserved</meta>
        <dc:rights>Copyright &#x00A9; <%= (new Date()).getFullYear() %> by <%= publisher %></dc:rights>
        <% if(cover) { %>
        <meta name="cover" content="image_cover"/>
        <% } %>
        <meta name="generator" content="epub-gen" />
        <meta property="ibooks:specified-fonts">true</meta>

        <meta property="belongs-to-collection" id="series-id">${SERIES_NAME}</meta>
        <meta refines="#series-id" property="collection-type">series</meta>
        <meta refines="#series-id" property="group-position">${tomoNum}</meta>
        <meta name="calibre:series" content="${SERIES_NAME}"/>
        <meta name="calibre:series_index" content="${tomoNum}"/>

    </metadata>

    <manifest>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
        <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav" />
        <item id="css" href="style.css" media-type="text/css" />

        <% if(cover) { %>
        <item id="image_cover" href="cover.<%= cover.extension %>" media-type="<%= cover.mediaType %>" />
        <% } %>

        <% images.forEach(function(image, index){ %>
        <item id="image_<%= index %>" href="images/<%= image.id %>.<%= image.extension %>" media-type="<%= image.mediaType %>" />
        <% }) %>

        <% content.forEach(function(content, index){ %>
        <item id="content_<%= index %>_<%= content.id %>" href="<%= content.filename %>" media-type="application/xhtml+xml" />
        <% }) %>

        <% fonts.forEach(function(font, index){%>
        <item id="font_<%= index%>" href="fonts/<%= font.filename %>" media-type="<%= font.mediaType %>" />
        <%})%>
    </manifest>

    <spine toc="ncx">
        <% content.forEach(function(content, index){ %>
            <% if(content.beforeToc){ %>
                <itemref idref="content_<%= index %>_<%= content.id %>"/>
            <% } %>
        <% }) %>
        <itemref idref="toc" />
        <% content.forEach(function(content, index){ %>
            <% if(!content.beforeToc){ %>
                <itemref idref="content_<%= index %>_<%= content.id %>"/>
            <% } %>
        <% }) %>
    </spine>
    <guide>
        <reference type="text" title="Table of Content" href="toc.xhtml"/>
    </guide>
</package>`;
}
