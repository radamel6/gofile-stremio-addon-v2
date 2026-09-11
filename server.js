const http = require("http");
const https = require("https");
const crypto = require("crypto");
const vm = require("vm");
const { URL } = require("url");

/*
=========================================================
 GOFILE → STREMIO ADDON
=========================================================

Para uma única pasta (modo antigo):
GOFILE_FOLDER=Hg4qUe

Para várias pastas (recomendado):
GOFILE_FOLDERS=Futebol:Hg4qUe,Filmes:abc123,Séries:def456

Exemplo de URL:
https://gofile.io/d/Hg4qUe
                     ^^^^^^

ORDENAÇÃO:

GOFILE_SORT=name_asc
GOFILE_SORT=name_desc
GOFILE_SORT=date_desc
GOFILE_SORT=date_asc
=========================================================
*/

const PORT =
  Number(process.env.PORT || 10000);

const GOFILE_FOLDER =
  process.env.GOFILE_FOLDER || "Hg4qUe";

/*
=========================================================
 DEFAULT / FALLBACK FOLDER
=========================================================

The environment variable is kept only as a fallback.
When the addon is configured in Stremio, the folder ID
comes from the addon URL and overrides this value.
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

const GOFILE_SORT =
  process.env.GOFILE_SORT || "name_asc";

const GOFILE_API =
  "https://api.gofile.io";

const GOFILE_WEB =
  "https://gofile.io";

const USER_AGENT =
  process.env.GOFILE_USER_AGENT ||
  process.env.USER_AGENT ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LANGUAGE =
  process.env.GOFILE_LANGUAGE ||
  process.env.LANGUAGE ||
  "en-US";

const CACHE_TIME =
  5 * 60 * 1000;

const ACCOUNT_CACHE_TIME =
  30 * 60 * 1000;

const WT_SECRET_CACHE_TIME =
  12 * 60 * 60 * 1000;

const REQUEST_TIMEOUT =
  30000;

/*
=========================================================
 GLOBAL CACHE
=========================================================
*/

const folderCache = new Map();

let guestAccountCache = {
  token: null,
  timestamp: 0
};

let websiteTokenSecretCache = {
  secret: null,
  scriptUrl: null,
  timestamp: 0
};

let websiteTokenSecretPromise = null;

/*
=========================================================
 HTTP REQUEST
=========================================================
*/

function request(
  method,
  targetUrl,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      let url;

      try {
        url =
          new URL(targetUrl);
      } catch (error) {
        reject(error);
        return;
      }

      const headers = {
        "User-Agent":
          USER_AGENT,
        "Accept-Language":
          LANGUAGE,
        "Accept":
          "application/json, text/plain, */*",
        "Connection":
          "close",
        ...(options.headers || {})
      };

      const req =
        https.request(
          {
            protocol:
              url.protocol,
            hostname:
              url.hostname,
            port:
              url.port || 443,
            path:
              url.pathname +
              url.search,
            method,
            headers,
            family:
              4,
            timeout:
              options.timeout ||
              REQUEST_TIMEOUT
          },
          res => {
            let body = "";

            res.setEncoding(
              "utf8"
            );

            res.on(
              "data",
              chunk => {
                body += chunk;
              }
            );

            res.on(
              "end",
              () => {
                resolve({
                  status:
                    res.statusCode || 0,
                  headers:
                    res.headers || {},
                  body
                });
              }
            );
          }
        );

      req.on(
        "timeout",
        () => {
          req.destroy(
            new Error(
              `Request timeout after ${
                options.timeout ||
                REQUEST_TIMEOUT
              }ms`
            )
          );
        }
      );

      req.on(
        "error",
        reject
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

/*
=========================================================
 JSON REQUEST
=========================================================
*/

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

  let data = null;

  try {
    data =
      JSON.parse(
        response.body
      );
  } catch (_) {
    data = null;
  }

  return {
    ...response,
    data
  };
}

/*
=========================================================
 SLEEP
=========================================================
*/

function sleep(
  ms
) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

/*
=========================================================
 CREATE GOFILE GUEST ACCOUNT
=========================================================
*/

async function createAccount(
  force = false
) {
  const now =
    Date.now();

  if (
    !force &&
    guestAccountCache.token &&
    now -
      guestAccountCache.timestamp <
      ACCOUNT_CACHE_TIME
  ) {
    return guestAccountCache.token;
  }

  const response =
    await jsonRequest(
      "POST",
      `${GOFILE_API}/accounts`,
      {
        headers: {
          "Content-Type":
            "application/json",
          "Origin":
            GOFILE_WEB,
          "Referer":
            `${GOFILE_WEB}/`
        },
        body:
          JSON.stringify({})
      }
    );

  if (
    response.data &&
    response.data.status ===
      "ok" &&
    response.data.data &&
    response.data.data.token
  ) {
    guestAccountCache = {
      token:
        response.data.data.token,
      timestamp:
        now
    };

    return (
      response.data.data.token
    );
  }

  throw new Error(
    `Falha ao criar conta GoFile: HTTP ${
      response.status
    } ${response.body}`
  );
}

/*
=========================================================
 STRING / SCRIPT HELPERS
=========================================================
*/

function normalizeText(
  value
) {
  return String(
    value == null
      ? ""
      : value
  );
}

function decodeEscapedString(
  value
) {
  return String(value)
    .replace(
      /\\x([0-9a-fA-F]{2})/g,
      (_, hex) =>
        String.fromCharCode(
          parseInt(
            hex,
            16
          )
        )
    )
    .replace(
      /\\u([0-9a-fA-F]{4})/g,
      (_, hex) =>
        String.fromCharCode(
          parseInt(
            hex,
            16
          )
        )
    );
}

/*
=========================================================
 WEBSITE TOKEN / WT.OBF.JS
=========================================================
*/

async function getWebsiteTokenSecret(
  force = false
) {
  const now =
    Date.now();

  if (
    !force &&
    websiteTokenSecretCache.secret &&
    now -
      websiteTokenSecretCache.timestamp <
      WT_SECRET_CACHE_TIME
  ) {
    return (
      websiteTokenSecretCache
    );
  }

  if (
    websiteTokenSecretPromise &&
    !force
  ) {
    return (
      websiteTokenSecretPromise
    );
  }

  websiteTokenSecretPromise =
    (async () => {
      const page =
        await request(
          "GET",
          `${GOFILE_WEB}/`
        );

      const html =
        page.body || "";

      const scriptMatches =
        html.match(
          /<script[^>]+src=["']([^"']+)["'][^>]*>/gi
        ) || [];

      let scriptUrls =
        scriptMatches.map(
          tag => {
            const match =
              tag.match(
                /src=["']([^"']+)["']/i
              );

            if (!match) {
              return null;
            }

            try {
              return new URL(
                match[1],
                GOFILE_WEB
              ).toString();
            } catch (_) {
              return null;
            }
          }
        )
        .filter(Boolean);

      scriptUrls =
        scriptUrls.filter(
          url =>
            /wt\.obf\.js/i.test(
              url
            ) ||
            /obf/i.test(
              url
            )
        );

      if (
        scriptUrls.length ===
        0
      ) {
        const allScripts =
          scriptMatches.map(
            tag => {
              const match =
                tag.match(
                  /src=["']([^"']+)["']/i
                );

              return match
                ? match[1]
                : null;
            }
          )
          .filter(Boolean);

        scriptUrls =
          allScripts.map(
            src => {
              try {
                return new URL(
                  src,
                  GOFILE_WEB
                ).toString();
              } catch (_) {
                return null;
              }
            }
          )
          .filter(Boolean);
      }

      let secret =
        null;

      let selectedScript =
        null;

      for (
        const scriptUrl of scriptUrls
      ) {
        try {
          const response =
            await request(
              "GET",
              scriptUrl
            );

          const script =
            response.body || "";

          const candidates = [
            script.match(
              /secret\s*=\s*["']([^"']+)["']/i
            ),
            script.match(
              /SECRET\s*=\s*["']([^"']+)["']/i
            ),
            script.match(
              /secret\s*:\s*["']([^"']+)["']/i
            ),
            script.match(
              /["']secret["']\s*:\s*["']([^"']+)["']/i
            ),
            script.match(
              /wtSecret\s*=\s*["']([^"']+)["']/i
            ),
            script.match(
              /WT_SECRET\s*=\s*["']([^"']+)["']/i
            )
          ];

          for (
            const candidate of candidates
          ) {
            if (
              candidate &&
              candidate[1]
            ) {
              secret =
                decodeEscapedString(
                  candidate[1]
                );

              selectedScript =
                scriptUrl;

              break;
            }
          }

          if (
            secret
          ) {
            break;
          }

          /*
          -------------------------------------------------
          Try to execute script in isolated VM
          -------------------------------------------------
          */

          const context = {
            window: {},
            globalThis: {},
            self: {},
            document: {},
            location: {
              href:
                GOFILE_WEB
            },
            console: {
              log() {},
              warn() {},
              error() {}
            }
          };

          vm.createContext(
            context
          );

          try {
            vm.runInContext(
              script,
              context,
              {
                timeout:
                  5000
              }
            );
          } catch (_) {
            // Expected for some browser-only scripts.
          }

          const objects = [
            context,
            context.window,
            context.globalThis,
            context.self
          ];

          for (
            const object of objects
          ) {
            if (
              !object
            ) {
              continue;
            }

            const keys =
              Object.keys(
                object
              );

            for (
              const key of keys
            ) {
              const value =
                object[key];

              if (
                typeof value ===
                  "string" &&
                value.length >
                  10 &&
                /secret|token|wt/i.test(
                  key
                )
              ) {
                secret =
                  value;

                selectedScript =
                  scriptUrl;

                break;
              }
            }

            if (
              secret
            ) {
              break;
            }
          }

          if (
            secret
          ) {
            break;
          }
        } catch (_) {
          continue;
        }
      }

      /*
      -----------------------------------------------------
      Fallback extraction directly from page
      -----------------------------------------------------
      */

      if (
        !secret
      ) {
        const candidates = [
          html.match(
            /secret\s*[:=]\s*["']([^"']+)["']/i
          ),
          html.match(
            /wtSecret\s*[:=]\s*["']([^"']+)["']/i
          ),
          html.match(
            /WT_SECRET\s*[:=]\s*["']([^"']+)["']/i
          )
        ];

        for (
          const candidate of candidates
        ) {
          if (
            candidate &&
            candidate[1]
          ) {
            secret =
              decodeEscapedString(
                candidate[1]
              );

            break;
          }
        }
      }

      if (
        !secret
      ) {
        throw new Error(
          "Não foi possível descobrir o secret do Website Token."
        );
      }

      websiteTokenSecretCache = {
        secret,
        scriptUrl:
          selectedScript,
        timestamp:
          Date.now()
      };

      return (
        websiteTokenSecretCache
      );
    })();

  try {
    return (
      await websiteTokenSecretPromise
    );
  } finally {
    websiteTokenSecretPromise =
      null;
  }
}

/*
=========================================================
 WEBSITE TOKEN GENERATION
=========================================================
*/

function createWebsiteToken(
  secret,
  folderId
) {
  const timestamp =
    Math.floor(
      Date.now() /
        1000
    );

  const payload =
    `${folderId}:${timestamp}`;

  return crypto
    .createHmac(
      "sha256",
      secret
    )
    .update(
      payload
    )
    .digest("hex");
}

/*
=========================================================
 GET WEBSITE TOKEN
=========================================================
*/

async function getWebsiteToken(
  folderId,
  force = false
) {
  const tokenInfo =
    await getWebsiteTokenSecret(
      force
    );

  const token =
    createWebsiteToken(
      tokenInfo.secret,
      folderId
    );

  return token;
}

/*
=========================================================
 GOFILE API CALL
=========================================================
*/

async function gofileApi(
  path,
  options = {}
) {
  const token =
    options.token ||
    await createAccount();

  const separator =
    path.includes("?")
      ? "&"
      : "?";

  const url =
    `${GOFILE_API}${path}${separator}token=${encodeURIComponent(token)}`;

  return jsonRequest(
    options.method || "GET",
    url,
    {
      headers: {
        "Authorization":
          `Bearer ${token}`,
        "Origin":
          GOFILE_WEB,
        "Referer":
          `${GOFILE_WEB}/`,
        ...(options.headers || {})
      },
      body:
        options.body
    }
  );
}

/*
=========================================================
 FILE LINK
=========================================================
*/

async function getFileLink(
  file,
  folderId = GOFILE_FOLDER
) {
  if (
    !file
  ) {
    return null;
  }

  if (
    file.link
  ) {
    return file.link;
  }

  if (
    file.downloadPage
  ) {
    return file.downloadPage;
  }

  if (
    file.url
  ) {
    return file.url;
  }

  const fileId =
    file.id ||
    file.fileId;

  if (
    !fileId
  ) {
    return null;
  }

  const accountToken =
    await createAccount();

  const websiteToken =
    await getWebsiteToken(
      folderId
    );

  const urls = [
    `${GOFILE_API}/contents/${encodeURIComponent(fileId)}?token=${encodeURIComponent(accountToken)}`,
    `${GOFILE_API}/contents/${encodeURIComponent(fileId)}`
  ];

  for (
    const url of urls
  ) {
    try {
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
              "Origin":
                GOFILE_WEB,
              "Referer":
                `${GOFILE_WEB}/d/${encodeURIComponent(folderId)}`
            }
          }
        );

      if (
        response.data &&
        response.data.status ===
          "ok"
      ) {
        const data =
          response.data.data ||
          {};

        const candidate =
          data.link ||
          data.downloadPage ||
          data.url ||
          data.directLink;

        if (
          candidate
        ) {
          return candidate;
        }
      }
    } catch (_) {
      continue;
    }
  }

  return null;
}

/*
=========================================================
 INSPECT FILE
=========================================================
*/

async function inspectFile(
  fileId,
  folderId = GOFILE_FOLDER
) {
  const folder =
    await loadFolder(
      folderId,
      false
    );

  const file =
    folder.files.find(
      item =>
        String(
          item.id
        ) ===
        String(
          fileId
        )
    );

  if (
    !file
  ) {
    return {
      ok: false,
      error:
        "Ficheiro não encontrado."
    };
  }

  let link =
    null;

  try {
    link =
      await getFileLink(
        file,
        folderId
      );
  } catch (error) {
    return {
      ok: false,
      error:
        error.message,
      file
    };
  }

  return {
    ok: true,
    file,
    link
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
  const list =
    Array.isArray(files)
      ? [...files]
      : [];

  const compareName =
    (a, b) =>
      String(
        a.name || ""
      ).localeCompare(
        String(
          b.name || ""
        ),
        undefined,
        {
          numeric: true,
          sensitivity:
            "base"
        }
      );

  const compareDate =
    (a, b) => {
      const da =
        Number(
          a.createTime ||
          a.modTime ||
          a.mtime ||
          a.modifiedTime ||
          0
        );

      const db =
        Number(
          b.createTime ||
          b.modTime ||
          b.mtime ||
          b.modifiedTime ||
          0
        );

      return (
        da - db
      );
    };

  switch (
    GOFILE_SORT
  ) {
    case "name_desc":
      list.sort(
        (a, b) =>
          compareName(
            b,
            a
          )
      );
      break;

    case "date_desc":
      list.sort(
        (a, b) =>
          compareDate(
            b,
            a
          )
      );
      break;

    case "date_asc":
      list.sort(
        compareDate
      );
      break;

    case "name_asc":
    default:
      list.sort(
        compareName
      );
      break;
  }

  return list;
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
  const normalized =
    normalizeFolderId(
      folderId
    );

  if (
    !normalized
  ) {
    throw new Error(
      "Folder ID inválido."
    );
  }

  const cached =
    folderCache.get(
      normalized
    );

  if (
    !force &&
    cached &&
    Date.now() -
      cached.timestamp <
      CACHE_TIME
  ) {
    return cached.data;
  }

  const accountToken =
    await createAccount();

  const websiteToken =
    await getWebsiteToken(
      normalized
    );

  const url =
    `${GOFILE_API}/contents/${encodeURIComponent(normalized)}?token=${encodeURIComponent(accountToken)}&websiteToken=${encodeURIComponent(websiteToken)}&cache=true`;

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
          "Origin":
            GOFILE_WEB,
          "Referer":
            `${GOFILE_WEB}/d/${encodeURIComponent(normalized)}`
        }
      }
    );

  if (
    !response.data ||
    response.data.status !==
      "ok"
  ) {
    throw new Error(
      `Erro ao carregar pasta GoFile: HTTP ${
        response.status
      } ${response.body}`
    );
  }

  const data =
    response.data.data ||
    {};

  const children =
    data.children ||
    data.contents ||
    data.files ||
    {};

  let files = [];

  if (
    Array.isArray(
      children
    )
  ) {
    files =
      children;
  } else {
    files =
      Object.values(
        children
      );
  }

  files =
    files.filter(
      file =>
        file &&
        (
          file.type ===
            "file" ||
          file.type ===
            "video" ||
          file.mimeType ||
          file.mime ||
          file.name
        )
    );

  files =
    sortFiles(
      files
    );

  const result = {
    folderId:
      normalized,
    name:
      data.name ||
      normalized,
    files
  };

  folderCache.set(
    normalized,
    {
      timestamp:
        Date.now(),
      data:
        result
    }
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
  return loadFolder(
    folderId,
    force
  );
}

/*
=========================================================
 MIME HELPERS
=========================================================
*/

function isVideoFile(
  file
) {
  if (
    !file
  ) {
    return false;
  }

  const mime =
    String(
      file.mimeType ||
      file.mime ||
      ""
    ).toLowerCase();

  const name =
    String(
      file.name ||
      ""
    ).toLowerCase();

  if (
    mime.startsWith(
      "video/"
    )
  ) {
    return true;
  }

  return /\.(mp4|mkv|avi|mov|webm|m4v|ts|m2ts|wmv|flv)$/i.test(
    name
  );
}

function getMimeType(
  file
) {
  const mime =
    file &&
    (
      file.mimeType ||
      file.mime
    );

  if (
    mime
  ) {
    return mime;
  }

  const name =
    String(
      file &&
      file.name ||
      ""
    ).toLowerCase();

  if (
    name.endsWith(
      ".mp4"
    )
  ) {
    return "video/mp4";
  }

  if (
    name.endsWith(
      ".mkv"
    )
  ) {
    return "video/x-matroska";
  }

  if (
    name.endsWith(
      ".webm"
    )
  ) {
    return "video/webm";
  }

  if (
    name.endsWith(
      ".mov"
    )
  ) {
    return "video/quicktime";
  }

  if (
    name.endsWith(
      ".avi"
    )
  ) {
    return "video/x-msvideo";
  }

  if (
    name.endsWith(
      ".m4v"
    )
  ) {
    return "video/x-m4v";
  }

  if (
    name.endsWith(
      ".ts"
    ) ||
    name.endsWith(
      ".m2ts"
    )
  ) {
    return "video/mp2t";
  }

  return "application/octet-stream";
}

/*
=========================================================
 FILE NAME HELPERS
=========================================================
*/

function cleanTitle(
  name
) {
  let title =
    String(
      name ||
      ""
    );

  title =
    title.replace(
      /\.[^.]+$/,
      ""
    );

  title =
    title.replace(
      /[_]+/g,
      " "
    );

  title =
    title.replace(
      /\s+/g,
      " "
    );

  return title.trim();
}

/*
=========================================================
 MANIFEST
=========================================================
*/

function buildManifest(
  folderId = null
) {
  const configured =
    !!folderId;

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
        type:
          "other",
        id:
          "gofile-videos",
        name:
          "GoFile Videos"
      }
    ],

    idPrefixes: [
      "gofile:"
    ],

    behaviorHints: {
      configurable:
        true,
      configurationRequired:
        !configured
    },

    config: [
      {
        key:
          "gofile_folder",
        type:
          "text",
        title:
          "ID ou URL da pasta GoFile",
        required:
          true
      }
    ]
  };
}

/*
=========================================================
 NORMALIZE FOLDER ID
=========================================================
*/

function normalizeFolderId(
  value
) {
  if (
    !value
  ) {
    return null;
  }

  let folder =
    String(
      value
    ).trim();

  try {
    if (
      /^https?:\/\//i.test(
        folder
      )
    ) {
      const url =
        new URL(
          folder
        );

      const parts =
        url.pathname
          .split("/")
          .filter(
            Boolean
          );

      const dIndex =
        parts.indexOf(
          "d"
        );

      if (
        dIndex >=
          0 &&
        parts[
          dIndex + 1
        ]
      ) {
        folder =
          parts[
            dIndex + 1
          ];
      }
    }
  } catch (_) {}

  try {
    folder =
      decodeURIComponent(
        folder
      );
  } catch (_) {}

  folder =
    folder
      .replace(
        /^\/+|\/+$/g,
        ""
      )
      .trim();

  if (
    !folder
  ) {
    return null;
  }

  if (
    folder === "." ||
    folder === ".." ||
    folder.includes(
      "/"
    ) ||
    folder.includes(
      "\\"
    )
  ) {
    return null;
  }

  return folder;
}

/*
=========================================================
 ADDON CONTEXT
=========================================================
*/

function getAddonContext(
  pathname
) {
  const prefixed =
    pathname.match(
      /^\/([^/]+)(\/.*)$/
    );

  if (
    !prefixed
  ) {
    return {
      folderId:
        null,
      addonPath:
        pathname
    };
  }

  const candidate =
    normalizeFolderId(
      prefixed[1]
    );

  const rest =
    prefixed[2];

  const isAddonRoute =
    rest ===
      "/manifest.json" ||
    rest ===
      "/configure" ||
    rest ===
      "/diagnostico" ||
    rest ===
      "/refresh" ||
    rest ===
      "/teste-link" ||
    rest ===
      "/teste-file" ||
    rest ===
      "/teste-wt" ||
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

/*
=========================================================
 HTML ESCAPE
=========================================================
*/

function escapeHtml(
  value
) {
  return String(
    value || ""
  )
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

/*
=========================================================
 CONFIGURE PAGE
=========================================================
*/

function renderConfigurePage(
  req,
  res,
  currentFolder = ""
) {
  const forwardedProto =
    String(
      req.headers[
        "x-forwarded-proto"
      ] ||
      ""
    )
      .split(",")[0]
      .trim();

  const protocol =
    forwardedProto ||
    "https";

  const host =
    req.headers.host ||
    "";

  const escapedFolder =
    escapeHtml(
      currentFolder
    );

  const html = `
<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GoFile Videos</title>
<style>
body {
  font-family: Arial, sans-serif;
  background: #111;
  color: #fff;
  margin: 0;
  padding: 40px 20px;
}
.container {
  max-width: 620px;
  margin: 0 auto;
}
h1 {
  margin-bottom: 10px;
}
p {
  color: #ccc;
  line-height: 1.5;
}
label {
  display: block;
  margin-top: 25px;
  margin-bottom: 8px;
}
input {
  width: 100%;
  box-sizing: border-box;
  padding: 14px;
  border-radius: 8px;
  border: 1px solid #444;
  background: #222;
  color: #fff;
  font-size: 16px;
}
button {
  margin-top: 20px;
  padding: 14px 20px;
  border: 0;
  border-radius: 8px;
  background: #4caf50;
  color: white;
  font-size: 16px;
  cursor: pointer;
}
.small {
  font-size: 13px;
  color: #999;
}
</style>
</head>
<body>
<div class="container">
<h1>GoFile Videos</h1>

<p>
Escolhe a pasta GoFile que queres utilizar neste addon.
</p>

<label for="folder">
ID ou URL da pasta GoFile
</label>

<input
  id="folder"
  type="text"
  value="${escapedFolder}"
  placeholder="Ex.: Hg4qUe ou https://gofile.io/d/Hg4qUe"
/>

<button onclick="installAddon()">
Adicionar ao Stremio
</button>

<p class="small">
A pasta escolhida fica associada apenas a esta instalação
do addon no Stremio.
</p>
</div>

<script>
function extractFolder(value) {
  value = String(value || "").trim();

  if (!value) {
    return "";
  }

  try {
    if (/^https?:\\/\\//i.test(value)) {
      const url = new URL(value);
      const parts =
        url.pathname
          .split("/")
          .filter(Boolean);

      const index =
        parts.indexOf("d");

      if (
        index >= 0 &&
        parts[index + 1]
      ) {
        return parts[index + 1];
      }
    }
  } catch (e) {}

  return value
    .replace(/^\\/+|\\/+$/g, "")
    .trim();
}

function installAddon() {
  const input =
    document.getElementById("folder");

  const folder =
    extractFolder(
      input.value
    );

  if (!folder) {
    alert(
      "Introduz o ID ou URL da pasta GoFile."
    );
    return;
  }

  const host =
    ${JSON.stringify(host)};

  const protocol =
    ${JSON.stringify(protocol)};

  const url =
    "stremio://" +
    host +
    "/" +
    encodeURIComponent(folder) +
    "/manifest.json";

  window.location.href =
    url;
}
</script>
</body>
</html>
`;

  res.writeHead(
    200,
    {
      "Content-Type":
        "text/html; charset=utf-8",
      "Cache-Control":
        "no-store"
    }
  );

  res.end(
    html
  );
}

/*
=========================================================
 RESPONSE HELPERS
=========================================================
*/

function sendJson(
  res,
  status,
  data
) {
  res.writeHead(
    status,
    {
      "Content-Type":
        "application/json; charset=utf-8",
      "Cache-Control":
        "no-store",
      "Access-Control-Allow-Origin":
        "*"
    }
  );

  res.end(
    JSON.stringify(
      data
    )
  );
}

function sendText(
  res,
  status,
  text
) {
  res.writeHead(
    status,
    {
      "Content-Type":
        "text/plain; charset=utf-8",
      "Cache-Control":
        "no-store"
    }
  );

  res.end(
    text
  );
}

/*
=========================================================
 HTTP STREAM / PROXY
=========================================================
*/

function proxyRequest(
  req,
  res,
  targetUrl,
  extraHeaders = {}
) {
  return new Promise(
    (resolve, reject) => {
      let url;

      try {
        url =
          new URL(
            targetUrl
          );
      } catch (error) {
        reject(error);
        return;
      }

      const headers = {
        "User-Agent":
          USER_AGENT,
        "Accept":
          "*/*",
        "Referer":
          `${GOFILE_WEB}/`,
        "Origin":
          GOFILE_WEB,
        ...extraHeaders
      };

      if (
        req.headers.range
      ) {
        headers.Range =
          req.headers.range;
      }

      const client =
        https.request(
          {
            protocol:
              url.protocol,
            hostname:
              url.hostname,
            port:
              url.port || 443,
            path:
              url.pathname +
              url.search,
            method:
              "GET",
            headers,
            family:
              4,
            timeout:
              REQUEST_TIMEOUT
          },
          upstream => {
            const responseHeaders = {};

            const allowedHeaders = [
              "content-type",
              "content-length",
              "content-range",
              "accept-ranges",
              "cache-control",
              "etag",
              "last-modified"
            ];

            for (
              const key of allowedHeaders
            ) {
              if (
                upstream.headers[key]
              ) {
                responseHeaders[
                  key
                ] =
                  upstream.headers[
                    key
                  ];
              }
            }

            responseHeaders[
              "Access-Control-Allow-Origin"
            ] = "*";

            responseHeaders[
              "Cache-Control"
            ] =
              "no-store";

            res.writeHead(
              upstream.statusCode ||
                200,
              responseHeaders
            );

            upstream.pipe(
              res
            );

            upstream.on(
              "end",
              resolve
            );

            upstream.on(
              "error",
              reject
            );
          }
        );

      client.on(
        "timeout",
        () => {
          client.destroy(
            new Error(
              "Proxy timeout"
            )
          );
        }
      );

      client.on(
        "error",
        reject
      );

      client.end();
    }
  );
}

/*
=========================================================
 PROXY VIDEO
=========================================================
*/

async function proxyVideo(
  req,
  res,
  fileId,
  folderId = GOFILE_FOLDER
) {
  const result =
    await inspectFile(
      fileId,
      folderId
    );

  if (
    !result.ok ||
    !result.link
  ) {
    sendJson(
      res,
      404,
      {
        error:
          result.error ||
          "Link de vídeo não encontrado."
      }
    );

    return;
  }

  await proxyRequest(
    req,
    res,
    result.link,
    {
      "Referer":
        `${GOFILE_WEB}/d/${encodeURIComponent(folderId)}`,
      "Origin":
        GOFILE_WEB
    }
  );
}

/*
=========================================================
 PROXY THUMBNAIL
=========================================================
*/

async function proxyThumbnail(
  req,
  res,
  fileId,
  folderId = GOFILE_FOLDER
) {
  const result =
    await inspectFile(
      fileId,
      folderId
    );

  if (
    !result.ok
  ) {
    sendJson(
      res,
      404,
      {
        error:
          result.error ||
          "Ficheiro não encontrado."
      }
    );

    return;
  }

  const file =
    result.file || {};

  const thumbnail =
    file.thumbnail ||
    file.thumbnailUrl ||
    file.poster ||
    file.posterUrl ||
    file.image ||
    file.imageUrl;

  if (
    thumbnail
  ) {
    try {
      await proxyRequest(
        req,
        res,
        thumbnail,
        {
          "Referer":
            `${GOFILE_WEB}/d/${encodeURIComponent(folderId)}`
        }
      );

      return;
    } catch (_) {}
  }

  if (
    result.link
  ) {
    try {
      const response =
        await jsonRequest(
          "HEAD",
          result.link,
          {
            headers: {
              "Referer":
                `${GOFILE_WEB}/d/${encodeURIComponent(folderId)}`
            }
          }
        );

      if (
        response.status >=
          200 &&
        response.status <
          400
      ) {
        /*
        No thumbnail available.
        */
      }
    } catch (_) {}
  }

  /*
  -------------------------------------------------------
  1x1 transparent GIF
  -------------------------------------------------------
  */

  const transparentGif =
    Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      "base64"
    );

  res.writeHead(
    200,
    {
      "Content-Type":
        "image/gif",
      "Content-Length":
        transparentGif.length,
      "Cache-Control":
        "public, max-age=3600"
    }
  );

  res.end(
    transparentGif
  );
}

/*
=========================================================
 URL BUILDER
=========================================================
*/

function getRequestBase(
  req
) {
  const forwardedProto =
    String(
      req.headers[
        "x-forwarded-proto"
      ] ||
      ""
    )
      .split(",")[0]
      .trim();

  const protocol =
    forwardedProto ||
    "https";

  const host =
    req.headers.host ||
    "";

  return {
    protocol,
    host
  };
}

/*
=========================================================
 SERVER
=========================================================
*/

const server =
  http.createServer(
    async (
      req,
      res
    ) => {
      try {
        const parsedUrl =
          new URL(
            req.url,
            `http://${
              req.headers.host ||
              "localhost"
            }`
          );

        const pathname =
          parsedUrl.pathname;

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
            ? `/${encodeURIComponent(
                folderId
              )}`
            : "";

        /*
        =================================================
        CORS / OPTIONS
        =================================================
        */

        if (
          req.method ===
          "OPTIONS"
        ) {
          res.writeHead(
            204,
            {
              "Access-Control-Allow-Origin":
                "*",
              "Access-Control-Allow-Methods":
                "GET,HEAD,OPTIONS",
              "Access-Control-Allow-Headers":
                "*"
            }
          );

          res.end();
          return;
        }

        /*
        =================================================
        CONFIGURE
        =================================================
        */

        if (
          addonPath ===
          "/configure"
        ) {
          renderConfigurePage(
            req,
            res,
            activeFolderId
          );

          return;
        }

        if (
          pathname ===
          "/configure"
        ) {
          renderConfigurePage(
            req,
            res,
            ""
          );

          return;
        }

        /*
        =================================================
        MANIFEST
        =================================================
        */

        if (
          addonPath ===
          "/manifest.json"
        ) {
          sendJson(
            res,
            200,
            buildManifest(
              folderId
            )
          );

          return;
        }

        if (
          pathname ===
          "/manifest.json"
        ) {
          sendJson(
            res,
            200,
            buildManifest(
              null
            )
          );

          return;
        }

        /*
        =================================================
        DIAGNOSTICO
        =================================================
        */

        if (
          addonPath ===
          "/diagnostico"
        ) {
          const cache =
            folderCache.get(
              activeFolderId
            );

          sendJson(
            res,
            200,
            {
              addon:
                "ok",
              folderId:
                activeFolderId,
              folderUrl:
                `${GOFILE_WEB}/d/${activeFolderId}`,
              sort:
                GOFILE_SORT,
              userAgent:
                USER_AGENT,
              language:
                LANGUAGE,
              cache:
                cache
                  ? {
                      timestamp:
                        cache.timestamp,
                      ageMs:
                        Date.now() -
                        cache.timestamp,
                      files:
                        cache.data &&
                        cache.data.files
                          ? cache
                              .data
                              .files
                              .length
                          : 0
                    }
                  : null
            }
          );

          return;
        }

        /*
        =================================================
        TESTE WT
        =================================================
        */

        if (
          addonPath ===
          "/teste-wt"
        ) {
          try {
            const info =
              await getWebsiteTokenSecret(
                true
              );

            const token =
              await getWebsiteToken(
                activeFolderId
              );

            sendJson(
              res,
              200,
              {
                ok:
                  true,
                folderId:
                  activeFolderId,
                scriptUrl:
                  info.scriptUrl,
                secretFound:
                  !!info.secret,
                token:
                  token
              }
            );
          } catch (error) {
            sendJson(
              res,
              500,
              {
                ok:
                  false,
                error:
                  error.message
              }
            );
          }

          return;
        }

        /*
        =================================================
        TESTE LINK
        =================================================
        */

        if (
          addonPath ===
          "/teste-link"
        ) {
          const fileId =
            parsedUrl.searchParams.get(
              "file"
            );

          if (
            !fileId
          ) {
            sendJson(
              res,
              400,
              {
                error:
                  "Falta o parâmetro ?file="
              }
            );

            return;
          }

          try {
            const result =
              await inspectFile(
                fileId,
                activeFolderId
              );

            sendJson(
              res,
              result.ok
                ? 200
                : 404,
              result
            );
          } catch (error) {
            sendJson(
              res,
              500,
              {
                ok:
                  false,
                error:
                  error.message
              }
            );
          }

          return;
        }

        /*
        =================================================
        TESTE FILE
        =================================================
        */

        if (
          addonPath ===
          "/teste-file"
        ) {
          const fileId =
            parsedUrl.searchParams.get(
              "file"
            );

          if (
            !fileId
          ) {
            sendJson(
              res,
              400,
              {
                error:
                  "Falta o parâmetro ?file="
              }
            );

            return;
          }

          try {
            const result =
              await inspectFile(
                fileId,
                activeFolderId
              );

            sendJson(
              res,
              result.ok
                ? 200
                : 404,
              result
            );
          } catch (error) {
            sendJson(
              res,
              500,
              {
                ok:
                  false,
                error:
                  error.message
              }
            );
          }

          return;
        }

        /*
        =================================================
        REFRESH
        =================================================
        */

        if (
          addonPath ===
          "/refresh"
        ) {
          if (
            folderId
          ) {
            folderCache.delete(
              activeFolderId
            );
          } else {
            folderCache.clear();
          }

          sendJson(
            res,
            200,
            {
              ok:
                true,
              folderId:
                activeFolderId,
              message:
                "Cache atualizado."
            }
          );

          return;
        }

        /*
        =================================================
        CATALOG
        =================================================
        */

        if (
          addonPath.startsWith(
            "/catalog/"
          )
        ) {
          const parts =
            addonPath
              .split("/")
              .filter(
                Boolean
              );

          /*
          /catalog/other/gofile-videos.json
          */

          if (
            parts.length <
            3
          ) {
            sendJson(
              res,
              404,
              {
                metas: []
              }
            );

            return;
          }

          const type =
            parts[1];

          const catalogFile =
            parts[2];

          const catalogId =
            catalogFile.replace(
              /\.json$/i,
              ""
            );

          if (
            type !==
              "other" ||
            catalogId !==
              "gofile-videos"
          ) {
            sendJson(
              res,
              404,
              {
                metas: []
              }
            );

            return;
          }

          try {
            const folder =
              await loadAllFolders(
                activeFolderId,
                false
              );

            const {
              protocol,
              host
            } =
              getRequestBase(
                req
              );

            const metas =
              folder.files
                .filter(
                  isVideoFile
                )
                .map(
                  file => ({
                    id:
                      `gofile:${file.id}`,
                    type:
                      "other",
                    name:
                      cleanTitle(
                        file.name
                      ),
                    poster:
                      `${protocol}://${host}${addonBasePath}/thumbnail/${encodeURIComponent(
                        file.id
                      )}`
                  })
                );

            sendJson(
              res,
              200,
              {
                metas
              }
            );
          } catch (error) {
            sendJson(
              res,
              500,
              {
                metas: [],
                error:
                  error.message
              }
            );
          }

          return;
        }

        /*
        =================================================
        META
        =================================================
        */

        if (
          addonPath.startsWith(
            "/meta/"
          )
        ) {
          const parts =
            addonPath
              .split("/")
              .filter(
                Boolean
              );

          if (
            parts.length <
            2
          ) {
            sendJson(
              res,
              404,
              {}
            );

            return;
          }

          let metaId =
            parts[1];

          try {
            metaId =
              decodeURIComponent(
                metaId
              );
          } catch (_) {}

          metaId =
            metaId.replace(
              /^gofile:/i,
              ""
            );

          try {
            const folder =
              await loadFolder(
                activeFolderId,
                false
              );

            const file =
              folder.files.find(
                item =>
                  String(
                    item.id
                  ) ===
                  String(
                    metaId
                  )
              );

            if (
              !file
            ) {
              sendJson(
                res,
                404,
                {}
              );

              return;
            }

            const {
              protocol,
              host
            } =
              getRequestBase(
                req
              );

            sendJson(
              res,
              200,
              {
                meta: {
                  id:
                    `gofile:${file.id}`,
                  type:
                    "other",
                  name:
                    cleanTitle(
                      file.name
                    ),
                  poster:
                    `${protocol}://${host}${addonBasePath}/thumbnail/${encodeURIComponent(
                      file.id
                    )}`,
                  description:
                    file.name ||
                    "",
                  runtime:
                    file.duration ||
                    undefined
                }
              }
            );
          } catch (error) {
            sendJson(
              res,
              500,
              {
                error:
                  error.message
              }
            );
          }

          return;
        }

        /*
        =================================================
        THUMBNAIL
        =================================================
        */

        if (
          addonPath.startsWith(
            "/thumbnail/"
          )
        ) {
          const fileId =
            addonPath.substring(
              "/thumbnail/".length
            );

          let decodedId =
            fileId;

          try {
            decodedId =
              decodeURIComponent(
                decodedId
              );
          } catch (_) {}

          try {
            await proxyThumbnail(
              req,
              res,
              decodedId,
              activeFolderId
            );
          } catch (error) {
            sendJson(
              res,
              500,
              {
                error:
                  error.message
              }
            );
          }

          return;
        }

        /*
        =================================================
        VIDEO PROXY
        =================================================
        */

        if (
          addonPath.startsWith(
            "/proxy/"
          )
        ) {
          const fileId =
            addonPath.substring(
              "/proxy/".length
            );

          let decodedId =
            fileId;

          try {
            decodedId =
              decodeURIComponent(
                decodedId
              );
          } catch (_) {}

          try {
            await proxyVideo(
              req,
              res,
              decodedId,
              activeFolderId
            );
          } catch (error) {
            sendJson(
              res,
              500,
              {
                error:
                  error.message
              }
            );
          }

          return;
        }

        /*
        =================================================
        STREAM
        =================================================
        */

        if (
          addonPath.startsWith(
            "/stream/"
          )
        ) {
          const parts =
            addonPath
              .split("/")
              .filter(
                Boolean
              );

          if (
            parts.length <
            2
          ) {
            sendJson(
              res,
              404,
              {
                streams: []
              }
            );

            return;
          }

          let streamId =
            parts[1];

          try {
            streamId =
              decodeURIComponent(
                streamId
              );
          } catch (_) {}

          streamId =
            streamId.replace(
              /^gofile:/i,
              ""
            );

          try {
            const folder =
              await loadFolder(
                activeFolderId,
                false
              );

            const file =
              folder.files.find(
                item =>
                  String(
                    item.id
                  ) ===
                  String(
                    streamId
                  )
              );

            if (
              !file
            ) {
              sendJson(
                res,
                404,
                {
                  streams: []
                }
              );

              return;
            }

            const {
              protocol,
              host
            } =
              getRequestBase(
                req
              );

            const streamUrl =
              `${protocol}://${host}${addonBasePath}/proxy/${encodeURIComponent(
                file.id
              )}`;

            sendJson(
              res,
              200,
              {
                streams: [
                  {
                    url:
                      streamUrl,
                    title:
                      file.name ||
                      "GoFile"
                  }
                ]
              }
            );
          } catch (error) {
            sendJson(
              res,
              500,
              {
                streams: [],
                error:
                  error.message
              }
            );
          }

          return;
        }

        /*
        =================================================
        ROOT
        =================================================
        */

        if (
          pathname ===
            "/" ||
          pathname ===
            ""
        ) {
          const {
            protocol,
            host
          } =
            getRequestBase(
              req
            );

          const configuredUrl =
            `${protocol}://${host}/configure`;

          sendText(
            res,
            200,
            [
              "GoFile → Stremio Addon",
              "",
              `Folder fallback: ${GOFILE_FOLDER}`,
              "",
              `Configuração: ${configuredUrl}`,
              "",
              "Para instalar no Stremio, abre /configure."
            ].join(
              "\n"
            )
          );

          return;
        }

        /*
        =================================================
        NOT FOUND
        =================================================
        */

        sendJson(
          res,
          404,
          {
            error:
              "Not found"
          }
        );
      } catch (error) {
        console.error(
          "REQUEST ERROR:",
          error
        );

        if (
          !res.headersSent
        ) {
          sendJson(
            res,
            500,
            {
              error:
                error.message ||
                "Internal Server Error"
            }
          );
        } else {
          res.end();
        }
      }
    }
  );

/*
=========================================================
 SERVER START
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
      "GoFile → Stremio Addon"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Fallback folder: ${GOFILE_FOLDER}`
    );

    console.log(
      `Sort: ${GOFILE_SORT}`
    );

    console.log(
      "=========================================="
    );
  }
);
