const http = require("http");
const https = require("https");
const crypto = require("crypto");
const vm = require("vm");
const { URL } = require("url");

/*
=========================================================
 GOFILE → STREMIO ADDON
=========================================================

Este addon:

- lê uma pasta GoFile
- cria uma conta guest GoFile
- carrega os conteúdos da pasta
- resolve links dos ficheiros
- fornece catálogo ao Stremio
- fornece metadata
- fornece streams
- faz proxy de vídeos
- faz proxy de thumbnails
- executa dinamicamente o wt.obf.js do GoFile
- permite escolher a pasta GoFile através da configuração
  do próprio addon no Stremio

CONFIGURAÇÃO

A variável GOFILE_FOLDER funciona como fallback.

Exemplo:

GOFILE_FOLDER=Hg4qUe

Mas o utilizador pode instalar o addon através de:

https://SEU-HOST/configure

e escolher outra pasta.

Nesse caso o ID da pasta passa no próprio caminho do addon:

/Hg4qUe/manifest.json
/Hg4qUe/catalog/...
/Hg4qUe/meta/...
/Hg4qUe/stream/...
/Hg4qUe/thumbnail/...
/Hg4qUe/proxy/...

Assim diferentes instalações podem utilizar diferentes
pastas GoFile sem alterar variáveis de ambiente globais.
=========================================================
*/

const PORT =
  Number(process.env.PORT) || 3000;

const GOFILE_FOLDER =
  process.env.GOFILE_FOLDER || "Hg4qUe";

const GOFILE_SORT =
  process.env.GOFILE_SORT || "date_desc";

const LANGUAGE =
  process.env.LANGUAGE || "en-US";

const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const GOFILE_WEB =
  "https://gofile.io";

const GOFILE_API =
  "https://api.gofile.io";

const WT_URL =
  "https://gofile.io/dist/js/wt.obf.js";


/*
=========================================================
 FOLDERS
=========================================================
*/

const FOLDERS = [
  {
    name: "GoFile Videos",
    id: GOFILE_FOLDER,
    catalogId: "gofile-videos"
  }
];

const FOLDER_BY_CATALOG =
  new Map(
    FOLDERS.map(folder => [
      folder.catalogId,
      folder
    ])
  );


/*
=========================================================
 GENERIC HELPERS
=========================================================
*/

function sendJson(
  res,
  data,
  statusCode = 200
) {
  if (res.headersSent) {
    return;
  }

  res.statusCode = statusCode;

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.end(
    JSON.stringify(
      data,
      null,
      2
    )
  );
}


function sendText(
  res,
  text,
  statusCode = 200
) {
  if (res.headersSent) {
    return;
  }

  res.statusCode = statusCode;

  res.setHeader(
    "Content-Type",
    "text/plain; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.end(
    text
  );
}


function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


function safeJsonParse(
  value,
  fallback = null
) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}


function getRequestUrl(req) {
  const host =
    req.headers.host ||
    "localhost";

  const protocol =
    req.headers["x-forwarded-proto"] ||
    "http";

  return new URL(
    req.url,
    `${protocol}://${host}`
  );
}


function getQueryParam(
  url,
  name
) {
  return url.searchParams.get(name);
}


/*
=========================================================
 HTTP REQUEST HELPER
=========================================================
*/

function requestRaw(
  targetUrl,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {

      let parsed;

      try {
        parsed =
          new URL(targetUrl);
      } catch (error) {
        reject(error);
        return;
      }

      const isHttps =
        parsed.protocol === "https:";

      const transport =
        isHttps
          ? https
          : http;

      const requestOptions = {
        method:
          options.method ||
          "GET",

        hostname:
          parsed.hostname,

        port:
          parsed.port ||
          (isHttps ? 443 : 80),

        path:
          `${parsed.pathname}${parsed.search}`,

        headers:
          options.headers || {},

        timeout:
          options.timeout ||
          30000
      };

      const req =
        transport.request(
          requestOptions,
          res => {

            const chunks = [];

            res.on(
              "data",
              chunk =>
                chunks.push(chunk)
            );

            res.on(
              "end",
              () => {

                const body =
                  Buffer.concat(
                    chunks
                  );

                resolve({
                  statusCode:
                    res.statusCode,

                  headers:
                    res.headers,

                  body
                });
              }
            );
          }
        );

      req.on(
        "error",
        reject
      );

      req.on(
        "timeout",
        () => {
          req.destroy(
            new Error(
              "Request timeout"
            )
          );
        }
      );

      if (options.body) {
        req.write(
          options.body
        );
      }

      req.end();
    }
  );
}


async function requestText(
  targetUrl,
  options = {}
) {
  const result =
    await requestRaw(
      targetUrl,
      options
    );

  return {
    ...result,
    text:
      result.body.toString(
        "utf8"
      )
  };
}


async function requestJson(
  targetUrl,
  options = {}
) {
  const result =
    await requestText(
      targetUrl,
      options
    );

  return {
    ...result,
    json:
      safeJsonParse(
        result.text
      )
  };
}


/*
=========================================================
 GOFILE WT
=========================================================
*/

let wtSource = null;
let wtContext = null;
let wtLoadedAt = 0;

const WT_CACHE_MS =
  60 * 60 * 1000;


async function loadWtScript(
  force = false
) {

  if (
    !force &&
    wtSource &&
    Date.now() - wtLoadedAt <
      WT_CACHE_MS
  ) {
    return wtSource;
  }

  console.log(
    "[WT] Downloading:",
    WT_URL
  );

  const result =
    await requestText(
      WT_URL,
      {
        timeout: 30000,
        headers: {
          "User-Agent":
            USER_AGENT,
          "Accept":
            "*/*",
          "Accept-Language":
            LANGUAGE,
          "Referer":
            GOFILE_WEB + "/"
        }
      }
    );

  if (
    result.statusCode < 200 ||
    result.statusCode >= 300
  ) {
    throw new Error(
      `Unable to download WT script. HTTP ${result.statusCode}`
    );
  }

  wtSource =
    result.text;

  wtLoadedAt =
    Date.now();

  console.log(
    "[WT] Script downloaded:",
    wtSource.length,
    "bytes"
  );

  return wtSource;
}


async function ensureWtContext(
  force = false
) {

  if (
    !force &&
    wtContext
  ) {
    return wtContext;
  }

  const source =
    await loadWtScript(
      force
    );

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,

    TextEncoder:
      global.TextEncoder,

    TextDecoder:
      global.TextDecoder,

    URL,

    crypto: {
      getRandomValues:
        array => {
          const bytes =
            crypto.randomBytes(
              array.length
            );

          array.set(bytes);
          return array;
        }
    }
  };

  sandbox.global =
    sandbox;

  sandbox.window =
    sandbox;

  sandbox.self =
    sandbox;

  sandbox.globalThis =
    sandbox;

  wtContext =
    vm.createContext(
      sandbox
    );

  try {
    new vm.Script(
      source,
      {
        filename:
          "wt.obf.js"
      }
    ).runInContext(
      wtContext,
      {
        timeout:
          30000
      }
    );
  } catch (error) {

    console.error(
      "[WT] Script execution error:",
      error
    );

    wtContext =
      null;

    throw error;
  }

  return wtContext;
}


/*
=========================================================
 GOFILE ACCOUNT
=========================================================
*/

let accountCache = null;
let accountCacheAt = 0;

const ACCOUNT_CACHE_MS =
  30 * 60 * 1000;


async function createAccount(
  force = false
) {

  if (
    !force &&
    accountCache &&
    Date.now() - accountCacheAt <
      ACCOUNT_CACHE_MS
  ) {
    return accountCache;
  }

  console.log(
    "[Account] Creating GoFile guest account..."
  );

  const result =
    await requestJson(
      `${GOFILE_API}/accounts`,
      {
        method:
          "POST",

        timeout:
          30000,

        headers: {
          "User-Agent":
            USER_AGENT,

          "Accept":
            "application/json",

          "Content-Type":
            "application/json",

          "Accept-Language":
            LANGUAGE
        },

        body:
          JSON.stringify({})
      }
    );

  if (
    result.statusCode < 200 ||
    result.statusCode >= 300
  ) {
    throw new Error(
      `GoFile account creation failed. HTTP ${result.statusCode}`
    );
  }

  const json =
    result.json;

  if (
    !json
  ) {
    throw new Error(
      "GoFile account creation returned invalid JSON"
    );
  }

  let token =
    null;

  if (
    json.data &&
    json.data.token
  ) {
    token =
      json.data.token;
  }

  if (
    json.token
  ) {
    token =
      json.token;
  }

  if (
    !token
  ) {
    throw new Error(
      "GoFile account token not found"
    );
  }

  accountCache = {
    token
  };

  accountCacheAt =
    Date.now();

  console.log(
    "[Account] Guest account created"
  );

  return accountCache;
}


/*
=========================================================
 GOFILE API
=========================================================
*/

async function gofileApi(
  path,
  options = {}
) {

  const account =
    await createAccount();

  const headers = {
    "User-Agent":
      USER_AGENT,

    "Accept":
      "application/json",

    "Accept-Language":
      LANGUAGE,

    "Cookie":
      `accountToken=${account.token}`,

    ...(options.headers || {})
  };

  const url =
    `${GOFILE_API}${path}`;

  const result =
    await requestJson(
      url,
      {
        ...options,
        headers
      }
    );

  if (
    result.statusCode === 401 ||
    result.statusCode === 403
  ) {

    console.log(
      "[Account] Token rejected. Recreating account..."
    );

    await createAccount(
      true
    );

    const newAccount =
      accountCache;

    const retryHeaders = {
      "User-Agent":
        USER_AGENT,

      "Accept":
        "application/json",

      "Accept-Language":
        LANGUAGE,

      "Cookie":
        `accountToken=${newAccount.token}`,

      ...(options.headers || {})
    };

    return await requestJson(
      url,
      {
        ...options,
        headers:
          retryHeaders
      }
    );
  }

  return result;
}


/*
=========================================================
 FOLDER CACHE
=========================================================
*/

const folderCache =
  new Map();


const fileLinkCache =
  new Map();


const inspectCache =
  new Map();


/*
=========================================================
 GET FOLDER CONTENTS
=========================================================
*/

async function getContents(
  folderId
) {

  if (!folderId) {
    throw new Error(
      "Missing GoFile folder ID"
    );
  }

  const endpoint =
    `/contents/${encodeURIComponent(folderId)}?wt=true`;

  console.log(
    "[GoFile] Loading folder:",
    folderId
  );

  const result =
    await gofileApi(
      endpoint,
      {
        method:
          "GET",

        timeout:
          30000
      }
    );

  if (
    result.statusCode < 200 ||
    result.statusCode >= 300
  ) {
    throw new Error(
      `GoFile contents failed. HTTP ${result.statusCode}`
    );
  }

  if (
    !result.json
  ) {
    throw new Error(
      "GoFile contents returned invalid JSON"
    );
  }

  return result.json;
}


async function getContentsWithRetry(
  folderId
) {

  try {

    return await getContents(
      folderId
    );

  } catch (error) {

    console.error(
      "[GoFile] Contents request failed:",
      error.message
    );

    await sleep(
      1000
    );

    return await getContents(
      folderId
    );
  }
}


/*
=========================================================
 LOAD FOLDER
=========================================================
*/

async function loadFolder(
  folderId = GOFILE_FOLDER,
  force = false
) {

  if (!folderId) {
    throw new Error(
      "No GoFile folder configured"
    );
  }

  if (
    !force &&
    folderCache.has(
      folderId
    )
  ) {

    return folderCache.get(
      folderId
    );
  }

  console.log(
    "[Folder] Loading:",
    folderId
  );

  const data =
    await getContentsWithRetry(
      folderId
    );

  const files = [];

  function walk(
    node
  ) {

    if (!node) {
      return;
    }

    if (
      Array.isArray(node)
    ) {

      for (
        const item of node
      ) {
        walk(item);
      }

      return;
    }

    if (
      typeof node !==
      "object"
    ) {
      return;
    }

    if (
      Array.isArray(
        node.children
      )
    ) {

      for (
        const child of
        node.children
      ) {
        walk(child);
      }
    }

    if (
      node.type === "file" ||
      node.type === "video"
    ) {

      files.push(
        node
      );
    }
  }

  if (
    data &&
    data.data
  ) {

    if (
      data.data.children
    ) {
      walk(
        data.data.children
      );
    } else {
      walk(
        data.data
      );
    }

  } else {

    walk(data);
  }

  const result = {
    folderId,
    data,
    files,
    loadedAt:
      Date.now()
  };

  folderCache.set(
    folderId,
    result
  );

  console.log(
    "[Folder] Loaded:",
    folderId,
    "files:",
    files.length
  );

  return result;
}


async function loadAllFolders(
  folderId = GOFILE_FOLDER,
  force = false
) {
  return await loadFolder(
    folderId,
    force
  );
}


/*
=========================================================
 FILE HELPERS
=========================================================
*/

function getFileId(
  file
) {
  if (!file) {
    return null;
  }

  return (
    file.id ||
    file.fileId ||
    file.file_id ||
    null
  );
}


function getFileName(
  file
) {
  if (!file) {
    return "Video";
  }

  return (
    file.name ||
    file.filename ||
    file.fileName ||
    "Video"
  );
}


function isVideoFile(
  file
) {

  if (!file) {
    return false;
  }

  const name =
    getFileName(file)
      .toLowerCase();

  const mime =
    String(
      file.mimetype ||
      file.mimeType ||
      file.type ||
      ""
    ).toLowerCase();

  const videoExtensions = [
    ".mp4",
    ".mkv",
    ".avi",
    ".mov",
    ".wmv",
    ".webm",
    ".m4v",
    ".ts",
    ".m2ts",
    ".flv",
    ".mpeg",
    ".mpg"
  ];

  if (
    videoExtensions.some(
      ext =>
        name.endsWith(ext)
    )
  ) {
    return true;
  }

  if (
    mime.startsWith(
      "video/"
    )
  ) {
    return true;
  }

  return false;
}


function getFileThumbnail(
  file
) {

  if (!file) {
    return null;
  }

  return (
    file.thumbnail ||
    file.thumbnailUrl ||
    file.thumbnail_url ||
    file.preview ||
    null
  );
}


function sortFiles(
  files
) {

  const cloned =
    [...files];

  if (
    GOFILE_SORT ===
    "name_asc"
  ) {

    cloned.sort(
      (a, b) =>
        getFileName(a)
          .localeCompare(
            getFileName(b),
            undefined,
            {
              numeric: true,
              sensitivity:
                "base"
            }
          )
    );

  } else if (
    GOFILE_SORT ===
    "name_desc"
  ) {

    cloned.sort(
      (a, b) =>
        getFileName(b)
          .localeCompare(
            getFileName(a),
            undefined,
            {
              numeric: true,
              sensitivity:
                "base"
            }
          )
    );

  } else {

    cloned.sort(
      (a, b) => {

        const ad =
          new Date(
            a.createTime ||
            a.createdAt ||
            a.modTime ||
            0
          ).getTime();

        const bd =
          new Date(
            b.createTime ||
            b.createdAt ||
            b.modTime ||
            0
          ).getTime();

        if (
          GOFILE_SORT ===
          "date_asc"
        ) {
          return ad - bd;
        }

        return bd - ad;
      }
    );
  }

  return cloned;
}


/*
=========================================================
 FILE LINK RESOLUTION
=========================================================
*/

async function getFileLink(
  file,
  folderId = GOFILE_FOLDER,
  force = false
) {

  const fileId =
    getFileId(file);

  if (!fileId) {
    throw new Error(
      "File ID not found"
    );
  }

  const cacheKey =
    `${folderId}:${fileId}`;

  if (
    !force &&
    fileLinkCache.has(
      cacheKey
    )
  ) {
    return fileLinkCache.get(
      cacheKey
    );
  }

  const account =
    await createAccount();

  const headers = {
    "User-Agent":
      USER_AGENT,

    "Accept":
      "*/*",

    "Accept-Language":
      LANGUAGE,

    "Referer":
      `${GOFILE_WEB}/d/${folderId}`,

    "Origin":
      GOFILE_WEB,

    "Cookie":
      `accountToken=${account.token}`,

    "Connection":
      "close"
  };

  let link =
    file.link ||
    file.downloadPage ||
    file.downloadUrl ||
    file.url ||
    null;

  if (
    !link
  ) {

    try {

      const endpoint =
        `/download/${encodeURIComponent(fileId)}`;

      const result =
        await requestRaw(
          `${GOFILE_API}${endpoint}`,
          {
            method:
              "GET",
            headers,
            timeout:
              30000
          }
        );

      const location =
        result.headers &&
        result.headers.location;

      if (
        location
      ) {
        link =
          location;
      }

    } catch (error) {

      console.error(
        "[FileLink] Download endpoint failed:",
        error.message
      );
    }
  }

  if (
    !link
  ) {

    const wt =
      await ensureWtContext();

    /*
     * Algumas versões do wt.obf.js
     * expõem funções diferentes.
     *
     * Mantemos a tentativa de descobrir
     * automaticamente a função disponível.
     */

    const candidates = [
      "getDownloadLink",
      "getFileLink",
      "download",
      "resolve",
      "getDirectLink"
    ];

    for (
      const name of
      candidates
    ) {

      try {

        const fn =
          wt[name];

        if (
          typeof fn !==
          "function"
        ) {
          continue;
        }

        const result =
          await fn(
            fileId,
            account.token
          );

        if (
          typeof result ===
          "string"
        ) {
          link =
            result;
          break;
        }

        if (
          result &&
          typeof result.url ===
            "string"
        ) {
          link =
            result.url;
          break;
        }

      } catch (_) {}
    }
  }

  if (
    !link
  ) {

    throw new Error(
      `Unable to resolve GoFile link for file ${fileId}`
    );
  }

  fileLinkCache.set(
    cacheKey,
    link
  );

  return link;
}


/*
=========================================================
 INSPECT FILE
=========================================================
*/

async function inspectFile(
  file,
  folderId = GOFILE_FOLDER,
  force = false
) {

  const fileId =
    getFileId(file);

  if (!fileId) {
    throw new Error(
      "Missing file ID"
    );
  }

  const cacheKey =
    `${folderId}:${fileId}`;

  if (
    !force &&
    inspectCache.has(
      cacheKey
    )
  ) {
    return inspectCache.get(
      cacheKey
    );
  }

  let link =
    null;

  try {

    link =
      await getFileLink(
        file,
        folderId,
        force
      );

  } catch (error) {

    console.error(
      "[Inspect] Unable to resolve file:",
      fileId,
      error.message
    );
  }

  const result = {
    id:
      fileId,

    name:
      getFileName(file),

    thumbnail:
      getFileThumbnail(file),

    link,

    raw:
      file
  };

  inspectCache.set(
    cacheKey,
    result
  );

  return result;
}


/*
=========================================================
 VIDEO PROXY
=========================================================
*/

async function proxyVideo(
  req,
  res,
  file,
  folderId = GOFILE_FOLDER
) {

  let targetUrl;

  try {

    targetUrl =
      await getFileLink(
        file,
        folderId
      );

  } catch (error) {

    console.error(
      "[Proxy] Unable to resolve file:",
      error.message
    );

    res.statusCode =
      502;

    return res.end(
      "Unable to resolve GoFile video"
    );
  }

  try {

    const parsed =
      new URL(
        targetUrl
      );

    const isHttps =
      parsed.protocol ===
      "https:";

    const transport =
      isHttps
        ? https
        : http;

    const headers = {
      "User-Agent":
        USER_AGENT,

      "Accept":
        "*/*",

      "Accept-Language":
        LANGUAGE,

      "Referer":
        `${GOFILE_WEB}/d/${folderId}`,

      "Origin":
        GOFILE_WEB,

      "Connection":
        "close"
    };

    if (
      req.headers.range
    ) {

      headers.Range =
        req.headers.range;
    }

    const requestOptions = {
      method:
        req.method ===
        "HEAD"
          ? "HEAD"
          : "GET",

      hostname:
        parsed.hostname,

      port:
        parsed.port ||
        (isHttps ? 443 : 80),

      path:
        `${parsed.pathname}${parsed.search}`,

      headers,

      timeout:
        60000
    };

    const upstream =
      transport.request(
        requestOptions,
        upstreamRes => {

          const copyHeaders = [
            "content-type",
            "content-length",
            "accept-ranges",
            "content-range",
            "cache-control",
            "etag",
            "last-modified"
          ];

          for (
            const headerName of
            copyHeaders
          ) {

            const value =
              upstreamRes.headers[
                headerName
              ];

            if (
              value !== undefined
            ) {

              res.setHeader(
                headerName,
                value
              );
            }
          }

          if (
            !res.getHeader(
              "Content-Type"
            )
          ) {

            res.setHeader(
              "Content-Type",
              "video/mp4"
            );
          }

          if (
            upstreamRes.statusCode ===
            206
          ) {

            res.statusCode =
              206;

          } else if (
            upstreamRes.statusCode
          ) {

            res.statusCode =
              upstreamRes.statusCode;
          }

          if (
            req.method ===
            "HEAD"
          ) {

            upstreamRes.resume();

            return res.end();
          }

          upstreamRes.pipe(
            res
          );

          upstreamRes.on(
            "error",
            error => {

              console.error(
                "[Proxy] Upstream stream error:",
                error.message
              );

              if (
                !res.headersSent
              ) {

                res.statusCode =
                  502;

                res.end();

              } else {

                res.destroy();
              }
            }
          );
        }
      );

    upstream.on(
      "timeout",
      () => {

        console.error(
          "[Proxy] GoFile request timeout"
        );

        upstream.destroy(
          new Error(
            "GoFile video request timeout"
          )
        );
      }
    );

    upstream.on(
      "error",
      error => {

        console.error(
          "[Proxy] GoFile request error:",
          error.message
        );

        if (
          !res.headersSent
        ) {

          res.statusCode =
            502;

          res.end(
            "GoFile proxy error"
          );

        } else {

          res.destroy();
        }
      }
    );

    upstream.end();

  } catch (error) {

    console.error(
      "[Proxy] Invalid video URL:",
      error.message
    );

    res.statusCode =
      500;

    res.end(
      "Invalid GoFile video URL"
    );
  }
}

      tokenConfigured:
        true,

      error:
        err.message
    };
  }
}


/*
=========================================================
 WEBSITE TOKEN DISCOVERY
=========================================================
*/

let websiteTokenSecretCache = {
  secret:
    null,

  scriptUrl:
    null,

  timestamp:
    0
};

let websiteTokenSecretPromise =
  null;

const WT_SECRET_CACHE_TIME =
  4 * 60 * 60 * 1000;


async function discoverWebsiteTokenScript() {

  const response =
    await request(
      "GET",
      `${GOFILE_WEB}/`,
      {
        headers: {
          "User-Agent":
            USER_AGENT,

          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

          "Accept-Language":
            LANGUAGE
        },

        timeout:
          20000
      }
    );

  if (
    response.status < 200 ||
    response.status >= 300
  ) {

    throw new Error(
      `GoFile homepage HTTP ${response.status}`
    );
  }

  const html =
    response.body ||
    "";

  const patterns = [

    /<script[^>]+src=["']([^"']*wt\.obf\.js[^"']*)["']/i,

    /<script[^>]+src=["']([^"']*wt[^"']*\.js[^"']*)["']/i,

    /["']([^"']*wt\.obf\.js[^"']*)["']/i

  ];

  for (
    const pattern of
    patterns
  ) {

    const match =
      html.match(
        pattern
      );

    if (
      !match ||
      !match[1]
    ) {
      continue;
    }

    let scriptUrl =
      match[1];

    try {

      scriptUrl =
        new URL(
          scriptUrl,
          GOFILE_WEB
        ).toString();

    } catch (_) {
      continue;
    }

    console.log(
      "[GoFile] WT script discovered:",
      scriptUrl
    );

    return scriptUrl;
  }

  throw new Error(
    "Unable to discover wt.obf.js from GoFile homepage"
  );
}


/*
=========================================================
 EXTRACT WT SECRET
=========================================================
*/

function extractWebsiteTokenSecret(
  script
) {

  if (
    !script ||
    typeof script !==
      "string"
  ) {

    throw new Error(
      "Invalid WT script"
    );
  }

  /*
   * Executamos o script dentro de um
   * contexto isolado e interceptamos
   * o input utilizado pela função
   * generateWT().
   */

  const probeToken =
    "gofile_probe_token";

  const probeUserAgent =
    USER_AGENT;

  const probeLanguage =
    LANGUAGE;

  let rawHashInput =
    null;

  const context =
    vm.createContext({

      console,

      setTimeout,

      clearTimeout,

      setInterval,

      clearInterval,

      URL,

      TextEncoder:
        global.TextEncoder,

      TextDecoder:
        global.TextDecoder,

      crypto: {
        getRandomValues:
          array => {

            const bytes =
              crypto.randomBytes(
                array.length
              );

            array.set(bytes);

            return array;
          }
      }

    });

  context.global =
    context;

  context.window =
    context;

  context.self =
    context;

  context.globalThis =
    context;

  try {

    vm.runInContext(
      script,
      context,
      {
        timeout:
          10000
      }
    );

  } catch (error) {

    throw new Error(
      `Unable to execute wt.obf.js: ${
        error.message
      }`
    );
  }


  if (
    typeof context.generateWT !==
    "function"
  ) {

    throw new Error(
      "generateWT function was not found in wt.obf.js"
    );
  }


  context._sha256 = (
    input
  ) => {

    rawHashInput =
      String(input);

    /*
     * O hash real não é necessário
     * nesta fase.
     *
     * Queremos apenas capturar
     * o texto que o WT tenta
     * enviar para SHA-256.
     */

    return "0".repeat(64);
  };


  try {

    vm.runInContext(
      `generateWT(${JSON.stringify(
        probeToken
      )})`,
      context,
      {
        timeout:
          3000
      }
    );

  } catch (error) {

    throw new Error(
      `generateWT execution failed: ${
        error.message
      }`
    );
  }


  if (
    !rawHashInput
  ) {

    throw new Error(
      "generateWT did not call _sha256"
    );
  }


  const expectedPrefix =
    `${probeUserAgent}::` +
    `${probeLanguage}::` +
    `${probeToken}::`;


  if (
    !rawHashInput.startsWith(
      expectedPrefix
    )
  ) {

    throw new Error(
      "Unexpected GoFile WT format: " +
      rawHashInput.slice(
        0,
        250
      )
    );
  }


  const remainder =
    rawHashInput.slice(
      expectedPrefix.length
    );


  const parts =
    remainder.split(
      "::"
    );


  if (
    parts.length < 2
  ) {

    throw new Error(
      "Unable to extract WT secret"
    );
  }


  const secret =
    parts
      .slice(1)
      .join("::")
      .trim();


  if (
    !secret
  ) {

    throw new Error(
      "GoFile WT secret is empty"
    );
  }


  console.log(
    `[GoFile] WT secret extracted (${secret.length} chars)`
  );


  return secret;
}


/*
=========================================================
 GET WT SECRET
=========================================================
*/

async function getWebsiteTokenSecret() {

  const now =
    Date.now();


  if (
    websiteTokenSecretCache.secret &&
    now -
      websiteTokenSecretCache.timestamp
      <
      WT_SECRET_CACHE_TIME
  ) {

    return {

      secret:
        websiteTokenSecretCache.secret,

      scriptUrl:
        websiteTokenSecretCache.scriptUrl

    };
  }


  if (
    websiteTokenSecretPromise
  ) {

    return websiteTokenSecretPromise;
  }


  websiteTokenSecretPromise =
    (async () => {

      const discovered =
        await discoverWebsiteTokenScript();


      if (
        !discovered
      ) {

        throw new Error(
          "Unable to obtain Gofile wt.obf.js"
        );
      }


      let scriptUrl;
      let script;


      if (
        typeof discovered ===
        "object"
      ) {

        scriptUrl =
          discovered.url;

        script =
          discovered.body;

      } else {

        scriptUrl =
          discovered;


        const response =
          await request(
            "GET",
            scriptUrl,
            {

              headers: {

                "Accept":
                  "application/javascript," +
                  "text/javascript,*/*;q=0.8",

                "Referer":
                  `${GOFILE_WEB}/`

              },

              timeout:
                20000
            }
          );


        if (
          response.status < 200 ||
          response.status >= 300
        ) {

          throw new Error(
            `WT script HTTP ${
              response.status
            }`
          );
        }


        script =
          response.body;
      }


      if (
        !script ||
        script.length < 100
      ) {

        throw new Error(
          "WT script was empty or invalid"
        );
      }


      console.log(
        `[GoFile] Executing WT script: ${scriptUrl}`
      );


      const secret =
        extractWebsiteTokenSecret(
          script
        );


      websiteTokenSecretCache = {

        secret,

        scriptUrl,

        timestamp:
          Date.now()

      };


      return {

        secret,

        scriptUrl

      };

    })()
      .finally(() => {

        websiteTokenSecretPromise =
          null;

      });


  return websiteTokenSecretPromise;
}


/*
=========================================================
 GENERATE WEBSITE TOKEN
=========================================================
*/

async function generateWebsiteToken(
  accountToken
) {

  const wt =
    await getWebsiteTokenSecret();


  const timeWindow =
    Math.floor(
      Date.now() /
      1000 /
      14400
    );


  const raw =
    `${USER_AGENT}::` +
    `${LANGUAGE}::` +
    `${accountToken}::` +
    `${timeWindow}::` +
    `${wt.secret}`;


  const token =
    crypto
      .createHash(
        "sha256"
      )
      .update(
        raw
      )
      .digest(
        "hex"
      );


  return {

    token,

    scriptUrl:
      wt.scriptUrl,

    timeWindow

  };
}


/*
=========================================================
 GOFILE CONTENTS
=========================================================
*/

async function getContents(
  folderId,
  accountToken,
  websiteToken
) {

  const params =
    new URLSearchParams({

      page:
        "1",

      pageSize:
        "1000",

      sortField:
        "name",

      sortDirection:
        "1"

    });


  const url =
    `${GOFILE_API}/contents/` +
    `${encodeURIComponent(folderId)}` +
    `?${params.toString()}`;


  const response =
    await jsonRequest(
      "GET",
      url,
      {

        headers: {

          "Authorization":
            `Bearer ${accountToken}`,

          "X-Website-Token":
            websiteToken,

          "X-BL":
            LANGUAGE,

          "User-Agent":
            USER_AGENT,

          "Accept":
            "application/json",

          "Referer":
            `${GOFILE_WEB}/d/${folderId}`,

          "Origin":
            GOFILE_WEB

        },

        timeout:
          REQUEST_TIMEOUT

      }
    );


  if (
    response.data &&
    response.data.status ===
      "ok"
  ) {

    return response.data;
  }


  throw new GoFileApiError(

    response.data
      ? (
        response.data.status ||
        "unknown"
      )
      : "http-error",

    response.status,

    response.data ||
      response.body

  );
}


/*
=========================================================
 CUSTOM GOFILE ERROR
=========================================================
*/

class GoFileApiError
  extends Error {

  constructor(
    status,
    httpStatus,
    data
  ) {

    super(
      `GoFile API error: ${
        JSON.stringify({
          status,
          httpStatus,
          data
        })
      }`
    );

    this.name =
      "GoFileApiError";

    this.gofileStatus =
      status;

    this.httpStatus =
      httpStatus;

    this.data =
      data;
  }
}


/*
=========================================================
 LOAD CONTENT WITH RETRIES
=========================================================
*/

async function getContentsWithRetry(
  folderId,
  accountToken,
  websiteToken
) {

  const maxRetries =
    4;


  for (
    let attempt = 0;
    attempt <= maxRetries;
    attempt++
  ) {

    try {

      return await getContents(
        folderId,
        accountToken,
        websiteToken
      );

    } catch (error) {

      const retryable =
        error &&
        (

          error.gofileStatus ===
            "error-rateLimit" ||

          error.httpStatus ===
            429 ||

          error.httpStatus >= 500

        );


      if (
        !retryable ||
        attempt === maxRetries
      ) {

        throw error;
      }


      const delay =
        2000 *
        Math.pow(
          2,
          attempt
        );


      console.log(
        `[GoFile] Rate limit/server error. ` +
        `Retry ${attempt + 1}/${maxRetries} ` +
        `in ${delay}ms`
      );


      await sleep(
        delay
      );


      if (
        error.gofileStatus ===
        "error-rateLimit"
      ) {

        guestAccountCache = {

          token:
            null,

          timestamp:
            0

        };


        const account =
          await createAccount(
            true
          );


        const generated =
          await generateWebsiteToken(
            account.token
          );


        accountToken =
          account.token;

        websiteToken =
          generated.token;
      }
    }
  }
}


/*
=========================================================
 GET REAL FILE LINK + THUMBNAIL
=========================================================
*/

async function getFileLink(
  fileId,
  accountToken,
  websiteToken,
  folderId = GOFILE_FOLDER
) {

  const url =
    `${GOFILE_API}/contents/` +
    `${encodeURIComponent(fileId)}`;


  const response =
    await jsonRequest(
      "GET",
      url,
      {

        headers: {

          "Authorization":
            `Bearer ${accountToken}`,

          "X-Website-Token":
            websiteToken,

          "X-BL":
            LANGUAGE,

          "User-Agent":
            USER_AGENT,

          "Accept":
            "application/json",

          "Referer":
            `${GOFILE_WEB}/d/${folderId}`,

          "Origin":
            GOFILE_WEB

        },

        timeout:
          REQUEST_TIMEOUT

      }
    );


  if (
    response.data &&
    response.data.status === "ok" &&
    response.data.data
  ) {

    const data =
      response.data.data;


    let realLink =
      null;


    /*
    -------------------------------------------------------
    Real video link
    -------------------------------------------------------
    */

    const possibleLinks = [

      data.link,

      data.directLink,

      data.downloadLink

    ];


    for (
      const link of possibleLinks
    ) {

      if (
        typeof link === "string" &&
        link.startsWith("http")
      ) {

        realLink =
          link;

        break;
      }
    }


    /*
    -------------------------------------------------------
    Thumbnail
    -------------------------------------------------------
    */

    const thumbnail =
      typeof data.thumbnail === "string" &&
      data.thumbnail.startsWith("http")
        ? data.thumbnail
        : null;


    /*
    -------------------------------------------------------
    Metadata
    -------------------------------------------------------
    */

    const createTime =
      Number(
        data.createTime ||
        0
      );


    const modTime =
      Number(
        data.modTime ||
        0
      );


    if (
      realLink
    ) {

      return {

        link:
          realLink,

        thumbnail,

        createTime,

        modTime

      };
    }
  }


  console.log(
    `[GoFile] Unable to get real link for ${fileId}:`,
    response.data ||
      response.body
  );


  return null;
}


/*
=========================================================
 INSPECT FILE
=========================================================
*/

async function inspectFile(
  fileId,
  accountToken,
  websiteToken,
  folderId = GOFILE_FOLDER
) {

  const url =
    `${GOFILE_API}/contents/` +
    `${encodeURIComponent(fileId)}`;


  const response =
    await jsonRequest(
      "GET",
      url,
      {

        headers: {

          "Authorization":
            `Bearer ${accountToken}`,

          "X-Website-Token":
            websiteToken,

          "X-BL":
            LANGUAGE,

          "User-Agent":
            USER_AGENT,

          "Accept":
            "application/json",

          "Referer":
            `${GOFILE_WEB}/d/${folderId}`,

          "Origin":
            GOFILE_WEB

        },

        timeout:
          REQUEST_TIMEOUT

      }
    );


  return {

    requestUrl:
      url,

    httpStatus:
      response.status,

    gofileStatus:
      response.data &&
      response.data.status,

    data:
      response.data &&
      response.data.data
        ? response.data.data
        : null,

    rawBody:
      response.body

  };
}


/*
=========================================================
 TEST DIRECT LINK
=========================================================
*/

async function testDirectLink(
  fileId,
  accountToken,
  websiteToken
) {

  const apiToken =
    process.env.GOFILE_TOKEN;


  if (
    !apiToken
  ) {

    return {

      ok:
        false,

      error:
        "GOFILE_TOKEN não está configurado no Render"

    };
  }


  const url =
    `${GOFILE_API}/contents/` +
    `${encodeURIComponent(fileId)}` +
    `/directlinks`;


  try {

    const result =
      await jsonRequest(
        "POST",
        url,
        {

          headers: {

            "Authorization":
              `Bearer ${apiToken}`,

            "User-Agent":
              USER_AGENT,

            "Accept":
              "application/json",

            "Content-Type":
              "application/json",

            "X-BL":
              LANGUAGE

          },

          body:
            JSON.stringify({})

        }
      );


    return {

      ok:
        true,

      authentication:
        "GOFILE_TOKEN",

      tokenConfigured:
        true,

      fileId,

      response:
        result

    };

  } catch (err) {

    return {

      ok:
        false,

      authentication:
        "GOFILE_TOKEN",

      tokenConfigured:
        true,

      error:
        err.message

    };
  }
}


/*
=========================================================
 REQUEST HELPERS
=========================================================
*/

function request(
  method,
  targetUrl,
  options = {}
) {

  return new Promise(
    (resolve, reject) => {

      let parsed;

      try {

        parsed =
          new URL(
            targetUrl
          );

      } catch (error) {

        reject(error);

        return;
      }


      const transport =
        parsed.protocol ===
        "https:"
          ? https
          : http;


      const headers =
        options.headers ||
        {};


      const requestOptions = {

        method,

        hostname:
          parsed.hostname,

        port:
          parsed.port ||
          (
            parsed.protocol ===
            "https:"
              ? 443
              : 80
          ),

        path:
          `${parsed.pathname}${parsed.search}`,

        headers,

        timeout:
          options.timeout ||
          REQUEST_TIMEOUT

      };


      const req =
        transport.request(
          requestOptions,
          response => {

            const chunks =
              [];


            response.on(
              "data",
              chunk => {

                chunks.push(
                  chunk
                );

              }
            );


            response.on(
              "end",
              () => {

                const body =
                  Buffer.concat(
                    chunks
                  );


                resolve({

                  status:
                    response.statusCode,

                  headers:
                    response.headers,

                  body:
                    body.toString(
                      "utf8"
                    )

                });

              }
            );

          }
        );


      req.on(
        "error",
        reject
      );


      req.on(
        "timeout",
        () => {

          req.destroy(
            new Error(
              "Request timeout"
            )
          );

        }
      );


      if (
        options.body
      ) {

        req.write(
          options.body
        );
      }


      req.end();

    }
  );
}


async function jsonRequest(
  method,
  targetUrl,
  options = {}
) {

  const response =
    await request(
      method,
      targetUrl,
      options
    );


  let data =
    null;


  try {

    data =
      JSON.parse(
        response.body
      );

  } catch (_) {}


  return {

    ...response,

    data

  };
}


const REQUEST_TIMEOUT =
  30000;


/*
=========================================================
 GUEST ACCOUNT CACHE
=========================================================
*/

let guestAccountCache = {

  token:
    null,

  timestamp:
    0

};


const GUEST_ACCOUNT_CACHE_TIME =
  30 * 60 * 1000;


async function createAccount(
  force = false
) {

  const now =
    Date.now();


  if (
    !force &&
    guestAccountCache.token &&
    now -
      guestAccountCache.timestamp
      <
      GUEST_ACCOUNT_CACHE_TIME
  ) {

    return {

      token:
        guestAccountCache.token

    };
  }


  const response =
    await jsonRequest(
      "POST",
      `${GOFILE_API}/accounts`,
      {

        headers: {

          "User-Agent":
            USER_AGENT,

          "Accept":
            "application/json",

          "Content-Type":
            "application/json",

          "X-BL":
            LANGUAGE,

          "Origin":
            GOFILE_WEB,

          "Referer":
            `${GOFILE_WEB}/`

        },

        body:
          JSON.stringify({}),

        timeout:
          REQUEST_TIMEOUT

      }
    );


  if (
    response.status < 200 ||
    response.status >= 300
  ) {

    throw new Error(
      `GoFile account HTTP ${response.status}`
    );
  }


  if (
    !response.data ||
    response.data.status !==
      "ok"
  ) {

    throw new Error(
      "GoFile account creation failed: " +
      JSON.stringify(
        response.data ||
        response.body
      )
    );
  }


  const token =
    response.data.data &&
    (
      response.data.data.token ||
      response.data.data.accountToken
    );


  if (
    !token
  ) {

    throw new Error(
      "GoFile account token missing"
    );
  }


  guestAccountCache = {

    token,

    timestamp:
      Date.now()

  };


  console.log(
    "[GoFile] Guest account created"
  );


  return {

    token

  };
}


/*
=========================================================
 FOLDER LOADER
=========================================================
*/

async function loadFolder(
  folderId = GOFILE_FOLDER,
  force = false
) {

  if (
    !folderId
  ) {

    throw new Error(
      "GoFile folder ID is missing"
    );
  }


  const cached =
    folderCache.get(
      folderId
    );


  if (
    !force &&
    cached &&
    cached.files
  ) {

    return cached;
  }


  const account =
    await createAccount();


  const websiteToken =
    await generateWebsiteToken(
      account.token
    );


  const data =
    await getContentsWithRetry(
      folderId,
      account.token,
      websiteToken.token
    );


  const files =
    [];


  function walk(
    node
  ) {

    if (
      !node
    ) {
      return;
    }


    if (
      Array.isArray(node)
    ) {

      for (
        const child of node
      ) {

        walk(
          child
        );

      }

      return;
    }


    if (
      typeof node !==
      "object"
    ) {

      return;
    }


    if (
      node.type ===
      "file"
    ) {

      files.push(
        node
      );

    }


    if (
      node.children
    ) {

      walk(
        node.children
      );

    }


    if (
      node.data &&
      node.data.children
    ) {

      walk(
        node.data.children
      );

    }

  }


  if (
    data &&
    data.data
  ) {

    walk(
      data.data
    );

  } else {

    walk(
      data
    );
  }


  const result = {

    folderId,

    files:
      sortFiles(
        files
      ),

    loadedAt:
      Date.now(),

    accountToken:
      account.token,

    websiteToken:
      websiteToken.token

  };


  folderCache.set(
    folderId,
    result
  );


  console.log(
    `[GoFile] Folder ${folderId}: ${files.length} files`
  );


  return result;
}


/*
=========================================================
 LOAD ALL FOLDERS
=========================================================
*/

async function loadAllFolders(
  folderId = GOFILE_FOLDER,
  force = false
) {

  return await loadFolder(
    folderId,
    force
  );
}


/*
=========================================================
 FILE HELPERS
=========================================================
*/

function getFileId(
  file
) {

  return (
    file &&
    (
      file.id ||
      file.fileId ||
      file.file_id
    )
  ) || null;
}


function getFileName(
  file
) {

  return (
    file &&
    (
      file.name ||
      file.filename ||
      file.fileName
    )
  ) ||
  "Video";
}


function getFileThumbnail(
  file
) {

  if (
    !file
  ) {
    return null;
  }


  return (
    file.thumbnail ||
    file.thumbnailUrl ||
    file.thumbnail_url ||
    file.preview ||
    null
  );
}


function isVideoFile(
  file
) {

  if (
    !file
  ) {
    return false;
  }


  const name =
    getFileName(
      file
    ).toLowerCase();


  const mime =
    String(
      file.mimetype ||
      file.mimeType ||
      file.type ||
      ""
    ).toLowerCase();


  if (
    mime.startsWith(
      "video/"
    )
  ) {

    return true;
  }


  const extensions = [

    ".mp4",
    ".mkv",
    ".avi",
    ".mov",
    ".wmv",
    ".webm",
    ".m4v",
    ".ts",
    ".m2ts",
    ".flv",
    ".mpeg",
    ".mpg"

  ];


  return extensions.some(
    extension =>
      name.endsWith(
        extension
      )
  );
}


function sortFiles(
  files
) {

  const result =
    [...files];


  if (
    GOFILE_SORT ===
    "name_asc"
  ) {

    result.sort(
      (a, b) =>
        getFileName(a)
          .localeCompare(
            getFileName(b),
            undefined,
            {
              numeric:
                true,

              sensitivity:
                "base"
            }
          )
    );


  } else if (
    GOFILE_SORT ===
    "name_desc"
  ) {

    result.sort(
      (a, b) =>
        getFileName(b)
          .localeCompare(
            getFileName(a),
            undefined,
            {
              numeric:
                true,

              sensitivity:
                "base"
            }
          )
    );


  } else {

    result.sort(
      (a, b) => {

        const aTime =
          Number(
            a.modTime ||
            a.createTime ||
            0
          );


        const bTime =
          Number(
            b.modTime ||
            b.createTime ||
            0
          );


        if (
          GOFILE_SORT ===
          "date_asc"
        ) {

          return (
            aTime -
            bTime
          );
        }


        return (
          bTime -
          aTime
        );

      }
    );
  }


  return result;
}

      fileId,

      error:
        err.message

    };

  }

}


/*
=========================================================
 VIDEO CHECK
=========================================================
*/

function isVideo(
  file
) {

  if (
    !file
  ) {

    return false;

  }


  const name =
    String(
      file.name ||
      file.originalName ||
      ""
    ).toLowerCase();


  const extensions = [

    ".mp4",
    ".mkv",
    ".avi",
    ".mov",
    ".webm",
    ".m4v",
    ".ts",
    ".m2ts",
    ".wmv",
    ".flv"

  ];


  return extensions.some(
    ext =>
      name.endsWith(ext)
  );

}


/*
=========================================================
 EXTRACT FILES
=========================================================
*/

function extractFiles(
  contents
) {

  const result = [];

  let items = [];


  if (
    contents &&
    contents.data &&
    contents.data.children
  ) {

    items =
      contents.data.children;

  }

  else if (
    contents &&
    contents.data &&
    contents.data.contents
  ) {

    items =
      contents.data.contents;

  }

  else if (
    contents &&
    contents.contents
  ) {

    items =
      contents.contents;

  }


  if (
    Array.isArray(items)
  ) {

    for (
      const item of items
    ) {

      if (
        isVideo(item)
      ) {

        result.push(item);

      }

    }

  }


  else if (
    items &&
    typeof items === "object"
  ) {

    for (
      const key of Object.keys(items)
    ) {

      const item =
        items[key];


      if (
        isVideo(item)
      ) {

        result.push(item);

      }

    }

  }


  return result;

}


/*
=========================================================
 NORMALIZE FILE
=========================================================
*/

function normalizeFile(
  file
) {

  return {

    id:
      file.id ||
      file.fileId ||
      file.contentId,

    name:
      file.name ||
      file.originalName ||
      "Video",

    size:
      file.size ||
      0,

    link:
      typeof file.link === "string" &&
      file.link.startsWith("http")
        ? file.link
        : null,

    thumbnail:
      typeof file.thumbnail === "string" &&
      file.thumbnail.startsWith("http")
        ? file.thumbnail
        : null,

    createTime:
      Number(
        file.createTime ||
        0
      ),

    modTime:
      Number(
        file.modTime ||
        0
      ),

    type:
      file.type ||
      "video",

    server:
      file.serverChoosen ||
      file.server ||
      null,

    raw:
      file

  };

}


/*
=========================================================
 SORT FILES
=========================================================
*/

function sortFiles(
  files
) {

  const sorted =
    [...files];


  const normalizeName =
    file =>
      String(
        file.name || ""
      ).toLocaleLowerCase(
        "pt-PT"
      );


  switch (
    GOFILE_SORT
  ) {

    /*
    -------------------------------------------------------
    NAME A → Z
    -------------------------------------------------------
    */

    case "name_asc":

      sorted.sort(
        (a, b) =>
          normalizeName(a)
            .localeCompare(
              normalizeName(b),
              "pt-PT",
              {
                numeric:
                  true,

                sensitivity:
                  "base"
              }
            )
      );

      break;


    /*
    -------------------------------------------------------
    NAME Z → A
    -------------------------------------------------------
    */

    case "name_desc":

      sorted.sort(
        (a, b) =>
          normalizeName(b)
            .localeCompare(
              normalizeName(a),
              "pt-PT",
              {
                numeric:
                  true,

                sensitivity:
                  "base"
              }
            )
      );

      break;


    /*
    -------------------------------------------------------
    DATE NEWEST → OLDEST
    -------------------------------------------------------
    */

    case "date_desc":

      sorted.sort(
        (a, b) => {

          const dateA =
            Number(
              a.modTime ||
              a.createTime ||
              0
            );

          const dateB =
            Number(
              b.modTime ||
              b.createTime ||
              0
            );


          return dateB - dateA;

        }
      );

      break;


    /*
    -------------------------------------------------------
    DATE OLDEST → NEWEST
    -------------------------------------------------------
    */

    case "date_asc":

      sorted.sort(
        (a, b) => {

          const dateA =
            Number(
              a.modTime ||
              a.createTime ||
              0
            );

          const dateB =
            Number(
              b.modTime ||
              b.createTime ||
              0
            );


          return dateA - dateB;

        }
      );

      break;


    /*
    -------------------------------------------------------
    INVALID VALUE
    -------------------------------------------------------
    */

    default:

      console.log(
        `[GoFile] Unknown GOFILE_SORT="${GOFILE_SORT}". ` +
        `Using name_asc.`
      );


      sorted.sort(
        (a, b) =>
          normalizeName(a)
            .localeCompare(
              normalizeName(b),
              "pt-PT",
              {
                numeric:
                  true,

                sensitivity:
                  "base"
              }
            )
      );

      break;

  }


  return sorted;

}


/*
=========================================================
 LOAD FOLDER
=========================================================
*/

async function loadFolder(
  folderId = FOLDERS[0].id,
  force = false
) {

  const now =
    Date.now();

  const cached =
    folderCache.get(folderId);

  if (
    !force &&
    cached &&
    cached.timestamp &&
    now - cached.timestamp < CACHE_TIME &&
    cached.files.length
  ) {
    return cached.files;
  }

  console.log(
    `[GoFile] Loading folder ${folderId}`
  );


  const account =
    await createAccount();


  const generated =
    await generateWebsiteToken(
      account.token
    );


  console.log(
    `[GoFile] Website token generated: ` +
    `${generated.token.slice(
      0,
      12
    )}...`
  );


  console.log(
    `[GoFile] WT script: ${generated.scriptUrl}`
  );


  const contents =
    await getContentsWithRetry(
      folderId,
      account.token,
      generated.token
    );


  const rawFiles =
    extractFiles(
      contents
    );


  const files = [];


  for (
    const rawFile of rawFiles
  ) {

    const file =
      normalizeFile(
        rawFile
      );


    /*
    -------------------------------------------------------
    The folder API often returns:
    "link": true

    Therefore we query the individual file endpoint.
    -------------------------------------------------------
    */

    if (
      !file.link
    ) {

      const fileInfo =
        await getFileLink(
          file.id,
          account.token,
          generated.token,
          folderId
        );


      if (
        fileInfo
      ) {

        file.link =
          fileInfo.link;

        file.thumbnail =
          fileInfo.thumbnail;

        file.createTime =
          fileInfo.createTime;

        file.modTime =
          fileInfo.modTime;

      }

    }


    /*
    -------------------------------------------------------
    If metadata already exists in folder response,
    keep it. Otherwise individual endpoint filled it.
    -------------------------------------------------------
    */

    if (
      file.link
    ) {

      files.push(
        file
      );

    } else {

      console.log(
        `[GoFile] No playable link for: ${file.name}`
      );

    }

  }


  /*
  -------------------------------------------------------
  SORT
  -------------------------------------------------------
  */

  const sortedFiles =
    sortFiles(
      files
    );


  console.log(
    `[GoFile] Found ${sortedFiles.length} video files`
  );


  console.log(
    `[GoFile] Sort mode: ${GOFILE_SORT}`
  );


  folderCache.set(
    folderId,
    {
      timestamp: now,
      files: sortedFiles
    }
  );


  return sortedFiles;

}


/*
=========================================================
 LOAD ALL FOLDERS
=========================================================
*/

async function loadAllFolders(
  folderId = GOFILE_FOLDER,
  force = false
) {

  return await loadFolder(
    folderId,
    force
  );

}


/*
=========================================================
 MANIFEST
=========================================================
*/

function buildManifest(folderId = null) {

  const configured = !!folderId;

  return {
    id:
      "com.andre.gofile",

    version:
      "1.4.0",

    name:
      "GoFile Videos",

    description:
      "Streams videos from a GoFile folder.",

    logo:
      "https://gofile.io/dist/img/favicon.png",

    resources: [
      "catalog",
      "meta",
      "stream"
    ],

    types: [
      "other"
    ],

    catalogs: [
      {
        type: "other",
        id: "gofile-videos",
        name: "GoFile Videos"
      }
    ],

    idPrefixes: [
      "gofile:"
    ],

    behaviorHints: {
      configurable: true,
      configurationRequired: !configured
    },

    config: [
      {
        key: "gofile_folder",
        type: "text",
        title: "ID ou URL da pasta GoFile",
        required: true
      }
    ]
  };
}


/*
=========================================================
 REMOVE EXTENSION
=========================================================
*/

function removeExtension(
  name
) {

  return String(name)
    .replace(
      /\.[^/.]+$/,
      ""
    );

}


/*
=========================================================
 SEND JSON
=========================================================
*/

function sendJson(
  res,
  object,
  status = 200
) {

  res.statusCode =
    status;


  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );


  res.setHeader(
    "Cache-Control",
    "no-store"
  );


  res.end(
    JSON.stringify(
      object,
      null,
      2
    )
  );

}


/*
=========================================================
 DIAGNOSTIC
=========================================================
*/

async function diagnostic(
  res,
  folderId = GOFILE_FOLDER
) {

  const result = {

    addon:
      "ok",

    folderId:
      folderId,

    folderUrl:
      `${GOFILE_WEB}/d/${folderId}`,

    sort:
      GOFILE_SORT,

    userAgent:
      USER_AGENT,

    language:
      LANGUAGE,

    api:
      GOFILE_API,

    tests: {

      websiteScript:
        false,

      websiteScriptUrl:
        null,

      websiteScriptHttpStatus:
        null,

      websiteSecret:
        false,

      websiteToken:
        false,

      accountStatus:
        null,

      accountOk:
        false,

      contentStatus:
        null,

      contentOk:
        false,

      fileCount:
        0,

      error:
        null

    },

    folder: {

      ok:
        false,

      count:
        0,

      files:
        []

    }

  };


  try {

    const discovered =
      await discoverWebsiteTokenScript();


    if (
      !discovered
    ) {

      throw new Error(
        "Unable to obtain Gofile wt.obf.js"
      );

    }


    result.tests.websiteScript =
      true;


    if (
      typeof discovered ===
      "object"
    ) {

      result.tests.websiteScriptUrl =
        discovered.url;

      result.tests.websiteScriptHttpStatus =
        200;

    } else {

      result.tests.websiteScriptUrl =
        discovered;

    }


    const wt =
      await getWebsiteTokenSecret();


    result.tests.websiteScriptUrl =
      wt.scriptUrl;

    result.tests.websiteSecret =
      !!wt.secret;


    const account =
      await createAccount();


    result.tests.accountOk =
      true;


    const generated =
      await generateWebsiteToken(
        account.token
      );


    result.tests.websiteToken =
      !!generated.token;


    let contents;


    try {

      contents =
        await getContentsWithRetry(
          folderId,
          account.token,
          generated.token
        );

    } catch (error) {

      result.tests.contentStatus =
        error.gofileStatus ||
        error.httpStatus ||
        null;

      throw error;

    }


    result.tests.contentOk =
      true;


    const files =
      extractFiles(
        contents
      )
      .map(
        normalizeFile
      );


    result.tests.fileCount =
      files.length;


    result.folder = {

      ok:
        true,

      count:
        files.length,

      files:
        files
          .slice(0, 100)
          .map(
            file => ({

              id:
                file.id,

              name:
                file.name,

              link:
                !!file.link,

              thumbnail:
                !!file.thumbnail,

              createTime:
                file.createTime,

              modTime:
                file.modTime,

              server:
                file.server

            })
          )

    };


  } catch (error) {

    console.error(
      "[DIAGNOSTIC ERROR]",
      error
    );


    result.tests.error =
      error.message;

  }

  return sendJson(
    res,
    result
  );

}


/*
=========================================================
 VIDEO PROXY
=========================================================
*/

async function proxyVideo(
  req,
  res,
  file,
  folderId = GOFILE_FOLDER
) {

  if (
    !file ||
    !file.link ||
    typeof file.link !== "string"
  ) {

    res.statusCode =
      404;

    return res.end(
      "Video link not available"
    );

  }


  let account;


  try {

    account =
      await createAccount();

  } catch (error) {

    console.error(
      "[Proxy] Unable to create GoFile account:",
      error.message
    );


    res.statusCode =
      502;

    return res.end(
      "Unable to authenticate with GoFile"
    );

  }


  const headers = {

    "User-Agent":
      USER_AGENT,

    "Accept":
      "*/*",

    "Accept-Language":
      LANGUAGE,

    "Referer":
      `${GOFILE_WEB}/d/${folderId}`,

    "Origin":
      GOFILE_WEB,

    "Cookie":
      `accountToken=${account.token}`,

    "Connection":
      "close"

  };


  if (
    req.headers.range
  ) {

    headers.Range =
      req.headers.range;

  }


  let upstream;


  try {

    const target =
      new URL(
        file.link
      );


    upstream =
      https.request(
        {

          protocol:
            target.protocol,

          hostname:
            target.hostname,

          port:
            target.port || 443,

          path:
            target.pathname +
            target.search,

          method:
            req.method === "HEAD"
              ? "HEAD"
              : "GET",

          headers,

          family:
            4,

          timeout:
            REQUEST_TIMEOUT

        },

        upstreamRes => {

          console.log(
            `[Proxy] ${req.method} ${file.name} -> ` +
            `${upstreamRes.statusCode}`
          );


          res.statusCode =
            upstreamRes.statusCode || 502;


          const copyHeaders = [

            "content-type",
            "content-length",
            "content-range",
            "accept-ranges",
            "etag",
            "last-modified",
            "cache-control"

          ];


          for (
            const headerName of copyHeaders
          ) {

            const value =
              upstreamRes.headers[
                headerName
              ];


            if (
              value !== undefined
            ) {

              res.setHeader(
                headerName,
                value
              );

            }

          }


          if (
            !res.getHeader(
              "Content-Type"
            )
          ) {

            res.setHeader(
              "Content-Type",
              "video/mp4"
            );

          }


          if (
            upstreamRes.statusCode ===
            206
          ) {

            res.statusCode =
              206;

          }


          if (
            req.method ===
            "HEAD"
          ) {

            upstreamRes.resume();

            return res.end();

          }


          upstreamRes.pipe(
            res
          );


          upstreamRes.on(
            "error",
            error => {

              console.error(
                "[Proxy] Upstream stream error:",
                error.message
              );


              if (
                !res.headersSent
              ) {

                res.statusCode =
                  502;

                res.end();

              } else {

                res.destroy();

              }

            }
          );

        }
      );


    upstream.on(
      "timeout",
      () => {

        console.error(
          "[Proxy] GoFile request timeout"
        );


        upstream.destroy(
          new Error(
            "GoFile video request timeout"
          )
        );

      }
    );


    upstream.on(
      "error",
      error => {

        console.error(
          "[Proxy] GoFile request error:",
          error.message
        );


        if (
          !res.headersSent
        ) {

          res.statusCode =
            502;

          res.end(
            "GoFile proxy error"
          );

        } else {

          res.destroy();

        }

      }
    );


    upstream.end();

  } catch (error) {

    console.error(
      "[Proxy] Invalid video URL:",
      error.message
    );


    res.statusCode =
      500;

    res.end(
      "Invalid GoFile video URL"
    );

  }

}


/*
=========================================================
 THUMBNAIL PROXY
=========================================================

O thumbnail do GoFile também pode exigir o
accountToken.

Por isso o Stremio nunca recebe diretamente
o URL do GoFile.

Stremio
   ↓
/thumbnail/ID
   ↓
Render
   ↓
GoFile + accountToken
   ↓
thumbnail
=========================================================
*/

async function proxyThumbnail(
  req,
  res,
  file,
  folderId = GOFILE_FOLDER
) {

  if (
    !file ||
    !file.thumbnail ||
    typeof file.thumbnail !== "string"
  ) {

    res.statusCode =
      404;

    return res.end(
      "Thumbnail not available"
    );

  }


  let account;


  try {

    account =
      await createAccount();

  } catch (error) {

    console.error(
      "[Thumbnail] Unable to create GoFile account:",
      error.message
    );


    res.statusCode =
      502;

    return res.end(
      "Unable to authenticate with GoFile"
    );

  }


  const headers = {

    "User-Agent":
      USER_AGENT,

    "Accept":
      "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",

    "Accept-Language":
      LANGUAGE,

    "Referer":
      `${GOFILE_WEB}/d/${folderId}`,

    "Origin":
      GOFILE_WEB,

    "Cookie":
      `accountToken=${account.token}`,

    "Connection":
      "close"

  };


  try {

    const target =
      new URL(
        file.thumbnail
      );


    const upstream =
      https.request(
        {

          protocol:
            target.protocol,

          hostname:
            target.hostname,

          port:
            target.port || 443,

          path:
            target.pathname +
            target.search,

          method:
            req.method === "HEAD"
              ? "HEAD"
              : "GET",

          headers,

          family:
            4,

          timeout:
            REQUEST_TIMEOUT

        },

        upstreamRes => {

          console.log(
            `[Thumbnail] ${file.name} -> ` +
            `${upstreamRes.statusCode}`
          );


          res.statusCode =
            upstreamRes.statusCode || 502;


          const copyHeaders = [

            "content-type",
            "content-length",
            "cache-control",
            "etag",
            "last-modified"

          ];


          for (
            const headerName of copyHeaders
          ) {

            const value =
              upstreamRes.headers[
                headerName
              ];


            if (
              value !== undefined
            ) {

              res.setHeader(
                headerName,
                value
              );

            }

          }


          /*
          -------------------------------------------------
          Cache thumbnail no Stremio
          -------------------------------------------------
          */

          if (
            !res.getHeader(
              "Cache-Control"
            )
          ) {

            res.setHeader(
              "Cache-Control",
              "public, max-age=3600"
            );

          }


          if (
            req.method ===
            "HEAD"
          ) {

            upstreamRes.resume();

            return res.end();

          }


          upstreamRes.pipe(
            res
          );


          upstreamRes.on(
            "error",
            error => {

              console.error(
                "[Thumbnail] Upstream error:",
                error.message
              );


              if (
                !res.headersSent
              ) {

                res.statusCode =
                  502;

                res.end();

              } else {

                res.destroy();

              }

            }
          );

        }
      );


    upstream.on(
      "timeout",
      () => {

        console.error(
          "[Thumbnail] GoFile request timeout"
        );


        upstream.destroy(
          new Error(
            "GoFile thumbnail request timeout"
          )
        );

      }
    );


    upstream.on(
      "error",
      error => {

        console.error(
          "[Thumbnail] Request error:",
          error.message
        );


        if (
          !res.headersSent
        ) {

          res.statusCode =
            502;

          res.end(
            "GoFile thumbnail proxy error"
          );

        } else {

          res.destroy();

        }

      }
    );


    upstream.end();

  } catch (error) {

    console.error(
      "[Thumbnail] Invalid thumbnail URL:",
      error.message
    );


    res.statusCode =
      500;

    res.end(
      "Invalid GoFile thumbnail URL"
    );

  }

}


/*
=========================================================
 CONFIGURATION / ROUTING HELPERS
=========================================================
*/

function normalizeFolderId(value) {

  if (!value) return null;

  let folder =
    String(value).trim();


  try {

    if (/^https?:\/\//i.test(folder)) {

      const url =
        new URL(folder);

      const parts =
        url.pathname
          .split("/")
          .filter(Boolean);

      const dIndex =
        parts.indexOf("d");


      if (
        dIndex >= 0 &&
        parts[dIndex + 1]
      ) {

        folder =
          parts[dIndex + 1];

      }

    }

  } catch (_) {}


  try {

    folder =
      decodeURIComponent(folder);

  } catch (_) {}


  folder =
    folder
      .replace(/^\/+|\/+$/g, "")
      .trim();


  if (!folder) return null;


  if (
    folder === "." ||
    folder === ".." ||
    folder.includes("/") ||
    folder.includes("\\")
  ) {

    return null;

  }


  return folder;

}


function getAddonContext(pathname) {

  const prefixed =
    pathname.match(
      /^\/([^/]+)(\/.*)$/
    );


  if (!prefixed) {

    return {
      folderId: null,
      addonPath: pathname
    };

  }


  const candidate =
    normalizeFolderId(
      prefixed[1]
    );

  const rest =
    prefixed[2];


  const isAddonRoute =

    rest === "/manifest.json" ||

    rest === "/configure" ||

    rest === "/diagnostico" ||

    rest === "/refresh" ||

    rest === "/teste-link" ||

    rest === "/teste-file" ||

    rest === "/teste-wt" ||

    rest.startsWith(
      "/catalog/"
    ) ||

    rest.startsWith(
      "/meta/"
    ) ||

    rest.startsWith(
      "/thumbnail/"
    ) ||

    rest.startsWith(
      "/proxy/"
    ) ||

    rest.startsWith(
      "/stream/"
    );


  if (
    candidate &&
    isAddonRoute
  ) {

    return {

      folderId:
        candidate,

      addonPath:
        rest

    };

  }


  return {

    folderId:
      null,

    addonPath:
      pathname

  };

}


function escapeHtml(value) {

  return String(value || "")
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /\"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );

}


function renderConfigurePage(
  req,
  res,
  currentFolder = ""
) {

  const host =
    req.headers.host;

  const protocol =
    req.headers["x-forwarded-proto"] ||
    "https";


  const httpsBase =
    `${protocol}://${host}`;


  const value =
    escapeHtml(
      currentFolder
    );


  res.statusCode =
    200;


  res.setHeader(
    "Content-Type",
    "text/html; charset=utf-8"
  );


  res.setHeader(
    "Cache-Control",
    "no-store"
  );


  res.end(`<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configurar GoFile Videos</title>
<style>
body{font-family:Arial,sans-serif;background:#111;color:#eee;margin:0;padding:30px}
.card{max-width:620px;margin:40px auto;background:#1d1d1d;padding:28px;border-radius:14px}
h1{margin-top:0}
label{display:block;margin:20px 0 8px}
input{width:100%;box-sizing:border-box;padding:13px;border-radius:8px;border:1px solid #555;background:#111;color:#fff;font-size:16px}
button{margin-top:20px;width:100%;padding:14px;border:0;border-radius:8px;background:#fff;color:#111;font-size:16px;font-weight:bold;cursor:pointer}
small{color:#aaa;line-height:1.5}
#error{color:#ff7777;margin-top:15px}
</style>
</head>
<body>
<div class="card">
<h1>GoFile Videos</h1>
<p>Escolhe a pasta GoFile que queres usar neste addon.</p>
<form id="form">
<label for="folder">ID ou URL da pasta GoFile</label>
<input id="folder" value="${value}" placeholder="Hg4qUe ou https://gofile.io/d/Hg4qUe" required>
<small>Podes colar diretamente o ID ou o URL completo da pasta.</small>
<button type="submit">Adicionar ao Stremio</button>
<div id="error"></div>
</form>
</div>
<script>
const base = ${JSON.stringify(httpsBase)};
const form = document.getElementById("form");
const input = document.getElementById("folder");
const error = document.getElementById("error");

function extractFolder(value){
  value = String(value || "").trim();

  if(/^https?:\\/\\//i.test(value)){
    try{
      const u = new URL(value);
      const parts = u.pathname.split("/").filter(Boolean);
      const i = parts.indexOf("d");

      if(i >= 0 && parts[i+1])
        value = parts[i+1];

    }catch(e){}
  }

  value = value.replace(/^\\/+|\\/+$/g, "").trim();

  return value;
}

form.addEventListener("submit", function(e){
  e.preventDefault();

  error.textContent = "";

  const folder =
    extractFolder(
      input.value
    );

  if(
    !folder ||
    folder.includes("/") ||
    folder.includes("\\\\")
  ){

    error.textContent =
      "Indica um ID ou URL válido de uma pasta GoFile.";

    return;

  }

  const installUrl =
    base.replace(
      /^https?:\\/\\//i,
      "stremio://"
    ) +
    "/" +
    encodeURIComponent(folder) +
    "/manifest.json";


  window.location.href =
    installUrl;

});
</script>
</body>
</html>`);

}


/*
=========================================================
 HTTP SERVER
=========================================================
*/

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        const parsed =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );


        const pathname =
          parsed.pathname;


        const {
          folderId,
          addonPath
        } =
          getAddonContext(
            pathname
          );


        const activeFolderId =
          folderId ||
          GOFILE_FOLDER;


        const addonBasePath =
          folderId
            ? `/${encodeURIComponent(folderId)}`
            : "";


        /*
        ---------------------------------------------------
        CORS
        ---------------------------------------------------
        */

        res.setHeader(
          "Access-Control-Allow-Origin",
          "*"
        );


        res.setHeader(
          "Access-Control-Allow-Headers",
          "*"
        );


        /*
        ---------------------------------------------------
        OPTIONS
        ---------------------------------------------------
        */

        if (
          req.method ===
          "OPTIONS"
        ) {

          res.statusCode =
            204;

          return res.end();

        }


        /*
        ---------------------------------------------------
        CONFIGURE
        ---------------------------------------------------
        */

        if (
          addonPath ===
          "/configure"
        ) {

          return renderConfigurePage(
            req,
            res,
            folderId || ""
          );

        }


        /*
        ---------------------------------------------------
        MANIFEST
        ---------------------------------------------------
        */

        if (
          addonPath ===
          "/manifest.json"
        ) {

          return sendJson(
            res,
            buildManifest(
              folderId
            )
          );

        }


        /*
        ---------------------------------------------------
        DIAGNOSTIC
        ---------------------------------------------------
        */

        if (
          addonPath ===
          "/diagnostico"
        ) {

          return await diagnostic(
            res,
            activeFolderId
          );

        }


        /*
        ---------------------------------------------------
        TEST LINK
        ---------------------------------------------------
        */

        if (
          addonPath ===
          "/teste-link"
        ) {

          return await testDirectLink(
            res,
            activeFolderId
          );

        }


        /*
        ---------------------------------------------------
        TEST FILE
        ---------------------------------------------------
        */

        if (
          addonPath ===
          "/teste-file"
                ) {
          try {
            const account =
              await createAccount();


            const websiteToken =
              await generateWebsiteToken(
                account.token
              );


            const fileId =
              parsed.searchParams.get(
                "id"
              ) ||
              "a4c4e316-e437-4c67-80a9-b8b42377c893";


            const result =
              await testDirectLink(
                fileId,
                account.token,
                websiteToken
              );


            return sendJson(
              res,
              result
            );

          } catch (err) {

            return sendJson(
              res,
              {
                ok:
                  false,
                error:
                  err.message
              },
              500
            );

          }
        }


        /*
        ---------------------------------------------------
        TEST FILE
        ---------------------------------------------------
        */

        if (
          addonPath ===
          "/teste-file"
        ) {

          try {

            const account =
              await createAccount();


            const generated =
              await generateWebsiteToken(
                account.token
              );


            const fileId =
              parsed.searchParams.get(
                "id"
              ) ||
              "a4c4e316-e437-4c67-80a9-b8b42377c893";


            const result =
              await inspectFile(
                fileId,
                account.token,
                generated.token,
                activeFolderId
              );


            return sendJson(
              res,
              result
            );

          } catch (error) {

            return sendJson(
              res,
              {
                ok:
                  false,
                error:
                  error.message
              },
              500
            );

          }

        }


        /*
        ---------------------------------------------------
        FORCE REFRESH
        ---------------------------------------------------
        */

        if (
          addonPath ===
          "/refresh"
        ) {

          if (folderId) {
            folderCache.delete(folderId);
          } else {
            folderCache.clear();
          }


          return sendJson(
            res,
            {
              ok:
                true,

              message:
                "Cache cleared"
            }
          );

        }


        /*
        ---------------------------------------------------
        TEST WT
        ---------------------------------------------------
        */

        if (
          addonPath ===
          "/teste-wt"
        ) {

          try {

            const account =
              await createAccount();


            const generated =
              await generateWebsiteToken(
                account.token
              );


            return sendJson(
              res,
              {
                ok:
                  true,

                scriptUrl:
                  generated.scriptUrl,

                timeWindow:
                  generated.timeWindow,

                websiteToken:
                  generated.token,

                websiteTokenPreview:
                  generated.token.slice(
                    0,
                    16
                  ) + "..."
              }
            );

          } catch (error) {

            return sendJson(
              res,
              {
                ok:
                  false,

                error:
                  error.message
              },
              500
            );

          }

        }


        /*
        ===================================================
        CATALOG
        ===================================================
        */

        const catalogMatch =
          addonPath.match(
            /^\/catalog\/other\/([^/]+)(?:\.json)?$/
          );


        if (
          catalogMatch
        ) {

          if (catalogMatch[1] !== "gofile-videos") {

            return sendJson(
              res,
              { metas: [] },
              404
            );

          }


          const files =
            await loadFolder(
              activeFolderId
            );


          const protocol =
            req.headers[
              "x-forwarded-proto"
            ] ||
            "https";


          const host =
            req.headers.host;


          const metas =
            files.map(
              (
                file,
                index
              ) => {

                let poster =
                  null;


                if (
                  file.thumbnail
                ) {

                  poster =
                    `${protocol}://${host}` +
                    `${addonBasePath}/thumbnail/` +
                    `${encodeURIComponent(
                      file.id
                    )}`;

                }


                return {

                  id:
                    `gofile:${
                      file.id ||
                      index
                    }`,

                  type:
                    "other",

                  name:
                    removeExtension(
                      file.name
                    ),

                  description:
                    file.name,

                  poster,

                  posterShape:
                    "landscape"

                };

              }
            );


          return sendJson(
            res,
            {
              metas
            }
          );

        }


        /*
        ===================================================
        META
        ===================================================
        */

        const metaMatch =
          addonPath.match(
            /^\/meta\/other\/([^/]+)\.json$/
          );


        if (
          metaMatch
        ) {

          const id =
            decodeURIComponent(
              metaMatch[1]
            )
            .replace(
              /^gofile:/,
              ""
            );


          const files =
            await loadFolder(
              activeFolderId
            );


          const file =
            files.find(
              f =>
                String(f.id) ===
                String(id)
            );


          if (
            !file
          ) {

            return sendJson(
              res,
              {
                meta: {

                  id:
                    `gofile:${id}`,

                  type:
                    "other",

                  name:
                    "GoFile Video"

                }
              }
            );

          }


          const protocol =
            req.headers[
              "x-forwarded-proto"
            ] ||
            "https";


          const host =
            req.headers.host;


          const poster =
            file.thumbnail
              ? (
                `${protocol}://${host}` +
                `${addonBasePath}/thumbnail/` +
                `${encodeURIComponent(
                  file.id
                )}`
              )
              : null;


          return sendJson(
            res,
            {
              meta: {

                id:
                  `gofile:${file.id}`,

                type:
                  "other",

                name:
                  removeExtension(
                    file.name
                  ),

                description:
                  file.name,

                poster,

                posterShape:
                  "landscape"

              }
            }
          );

        }


        /*
        ===================================================
        THUMBNAIL PROXY
        ===================================================
        */

        const thumbnailMatch =
          addonPath.match(
            /^\/thumbnail\/([^/]+)$/
          );


        if (
          thumbnailMatch
        ) {

          const id =
            decodeURIComponent(
              thumbnailMatch[1]
            );


          console.log(
            `[Thumbnail] Requested file: ${id}`
          );


          const files =
            await loadAllFolders(
              activeFolderId
            );


          const file =
            files.find(
              f =>
                String(f.id) ===
                String(id)
            );


          if (
            !file
          ) {

            res.statusCode =
              404;

            return res.end(
              "Video not found"
            );

          }


          return await proxyThumbnail(
            req,
            res,
            file,
            activeFolderId
          );

        }


        /*
        ===================================================
        VIDEO PROXY
        ===================================================
        */

        const proxyMatch =
          addonPath.match(
            /^\/proxy\/([^/]+)$/
          );


        if (
          proxyMatch
        ) {

          const id =
            decodeURIComponent(
              proxyMatch[1]
            );


          console.log(
            `[Proxy] Requested file: ${id}`
          );


          const files =
            await loadAllFolders(
              activeFolderId
            );


          const file =
            files.find(
              f =>
                String(f.id) ===
                String(id)
            );


          if (
            !file
          ) {

            res.statusCode =
              404;

            return res.end(
              "Video not found"
            );

          }


          return await proxyVideo(
            req,
            res,
            file,
            activeFolderId
          );

        }


        /*
        ===================================================
        STREAM
        ===================================================
        */

        const streamMatch =
          addonPath.match(
            /^\/stream\/other\/([^/]+)\.json$/
          );


        if (
          streamMatch
        ) {

          const id =
            decodeURIComponent(
              streamMatch[1]
            )
            .replace(
              /^gofile:/,
              ""
            );


          const files =
            await loadAllFolders(
              activeFolderId
            );


          const file =
            files.find(
              f =>
                String(f.id) ===
                String(id)
            );


          if (
            !file
          ) {

            return sendJson(
              res,
              {
                streams: []
              }
            );

          }


          if (
            !file.link
          ) {

            return sendJson(
              res,
              {
                streams: []
              }
            );

          }


          const protocol =
            req.headers[
              "x-forwarded-proto"
            ] ||
            "https";


          const host =
            req.headers.host;


          const proxyUrl =
            `${protocol}://${host}` +
            `${addonBasePath}/proxy/` +
            `${encodeURIComponent(
              file.id
            )}`;


          return sendJson(
            res,
            {
              streams: [

                {

                  name:
                    "GoFile",

                  title:
                    file.name,

                  url:
                    proxyUrl,

                  behaviorHints: {

                    notWebReady:
                      false

                  }

                }

              ]
            }
          );

        }


        /*
        ===================================================
        ROOT
        ===================================================
        */

        if (
          addonPath === "/" ||
          addonPath === ""
        ) {

          return sendJson(
            res,
            {
              addon:
                "ok",

              name:
                "GoFile Videos",

              folders:
                FOLDERS.map(folder => ({
                  name: folder.name,
                  id: folder.id,
                  catalogId: folder.catalogId
                })),

              sort:
                GOFILE_SORT,

              manifest:
                "/manifest.json",

              diagnostic:
                "/diagnostico",

              testWT:
                "/teste-wt",

              refresh:
                "/refresh"

            }
          );

        }


        /*
        ===================================================
        NOT FOUND
        ===================================================
        */

        return sendJson(
          res,
          {
            error:
              "notFound"
          },
          404
        );


      } catch (error) {

        console.error(
          "[SERVER ERROR]",
          error
        );


        return sendJson(
          res,
          {
            error:
              error.message ||
              "Internal server error"
          },
          500
        );

      }

    }
  );


/*
=========================================================
 START SERVER
=========================================================
*/

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "=========================================="
    );


    console.log(
      "GoFile Stremio Addon"
    );


    console.log(
      `Port: ${PORT}`
    );


    console.log(
      `Folders: ${FOLDERS.map(folder =>
        `${folder.name}=${folder.id}`
      ).join(" | ")}`
    );


    console.log(
      `Sort: ${GOFILE_SORT}`
    );


    console.log(
      `Language: ${LANGUAGE}`
    );


    console.log(
      `User-Agent: ${USER_AGENT}`
    );


    console.log(
      "Dynamic WT enabled"
    );


    console.log(
      "Thumbnail proxy enabled"
    );


    console.log(
      "Video proxy enabled"
    );


    console.log(
      "=========================================="
    );

  }
);
