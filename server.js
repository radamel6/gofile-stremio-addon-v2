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
  url,
  options = {}
) {

  const response =
    await request(
      method,
      url,
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

function sleep(ms) {

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
 GOFILE ACCOUNT
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
      guestAccountCache.timestamp
      <
      ACCOUNT_CACHE_TIME
  ) {

    return {

      token:
        guestAccountCache.token

    };

  }


  console.log(
    "[GoFile] Creating guest account..."
  );


  let response =
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


  /*
  -------------------------------------------------------
  If GoFile requires WT
  -------------------------------------------------------
  */

  if (
    !response.data ||
    response.data.status !== "ok" ||
    !response.data.data ||
    !response.data.data.token
  ) {

    try {

      const wt =
        await generateWebsiteToken("");

      console.log(
        "[GoFile] Retrying account creation with WT"
      );


      response =
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
                `${GOFILE_WEB}/`,

              "X-Website-Token":
                wt,

              "X-BL":
                LANGUAGE

            },

            body:
              JSON.stringify({})

          }
        );


    } catch (error) {

      console.log(
        "[GoFile] WT account retry failed:",
        error.message
      );

    }

  }


  if (
    !response.data
  ) {

    throw new Error(
      `GoFile account returned HTTP ${
        response.status
      }: ${
        response.body.slice(
          0,
          1000
        )
      }`
    );

  }


  if (
    response.data.status !== "ok" ||
    !response.data.data ||
    !response.data.data.token
  ) {

    throw new Error(
      `GoFile account error: ${
        JSON.stringify(
          response.data
        )
      }`
    );

  }


  const token =
    response.data.data.token;


  guestAccountCache = {

    token,

    timestamp:
      Date.now()

  };


  console.log(
    "[GoFile] Guest account created"
  );


  return {

    token,

    raw:
      response.data

  };

}


/*
=========================================================
 DISCOVER WT SCRIPT
=========================================================
*/

async function discoverWebsiteTokenScript() {

  const knownUrls = [

    `${GOFILE_WEB}/js/wt.obf.js`,

    `${GOFILE_WEB}/dist/js/wt.obf.js`,

    `${GOFILE_WEB}/dist/js/wt.js`

  ];


  try {

    console.log(
      "[GoFile] Inspecting homepage for WT script..."
    );


    const page =
      await request(
        "GET",
        `${GOFILE_WEB}/`,
        {

          headers: {

            "Accept":
              "text/html,application/xhtml+xml," +
              "application/xml;q=0.9,*/*;q=0.8",

            "Referer":
              `${GOFILE_WEB}/`

          },

          timeout:
            20000

        }
      );


    if (
      page.status >= 200 &&
      page.status < 300 &&
      page.body
    ) {

      const html =
        page.body;


      const scriptRegex =
        /<script[^>]+src=["']([^"']*wt[^"']*\.js(?:\?[^"']*)?)["'][^>]*>/gi;


      let match;


      while (
        (match =
          scriptRegex.exec(html))
      ) {

        let src =
          match[1];


        if (
          !src
        ) {

          continue;

        }


        try {

          const absolute =
            new URL(
              src,
              GOFILE_WEB
            ).toString();


          console.log(
            `[GoFile] WT script discovered: ${absolute}`
          );


          return absolute;

        } catch (_) {}

      }


      const looseRegex =
        /["']([^"']*wt[^"']*\.js(?:\?[^"']*)?)["']/gi;


      while (
        (match =
          looseRegex.exec(html))
      ) {

        let src =
          match[1];


        if (
          !src ||
          !src.includes("wt")
        ) {

          continue;

        }


        try {

          const absolute =
            new URL(
              src,
              GOFILE_WEB
            ).toString();


          console.log(
            `[GoFile] WT script found (loose): ${absolute}`
          );


          return absolute;

        } catch (_) {}

      }

    }

  } catch (error) {

    console.log(
      "[GoFile] Homepage discovery failed:",
      error.message
    );

  }


  for (
    const url of knownUrls
  ) {

    try {

      console.log(
        `[GoFile] Testing WT script: ${url}`
      );


      const response =
        await request(
          "GET",
          url,
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
        response.status >= 200 &&
        response.status < 300 &&
        response.body &&
        response.body.length > 100
      ) {

        console.log(
          `[GoFile] WT script available: ${url}`
        );


        return {

          url,

          body:
            response.body

        };

      }


      console.log(
        `[GoFile] WT script ${url} -> HTTP ${
          response.status
        }`
      );


    } catch (error) {

      console.log(
        `[GoFile] WT script failed ${url}: ${
          error.message
        }`
      );

    }

  }


  return null;

}


/*
=========================================================
 EXTRACT WT SECRET
=========================================================
*/

function extractWebsiteTokenSecret(
  script
) {

  let rawHashInput;


  const probeUserAgent =
    "HydraGofileUserAgent";

  const probeLanguage =
    "HydraGofileLanguage";

  const probeToken =
    "HydraGofileToken";


  const navigator = {

    userAgent:
      probeUserAgent,

    language:
      probeLanguage,

    languages: [
      probeLanguage
    ]

  };


  const contextObject = {

    appdata: {},

    console: {

      log: () => {},
      warn: () => {},
      error: () => {}

    },

    crypto:
      crypto.webcrypto,

    Date,

    Math,

    URL,

    URLSearchParams,

    TextEncoder,

    TextDecoder,

    setTimeout,

    clearTimeout,

    navigator,

    window: {

      crypto:
        crypto.webcrypto,

      navigator,

      location: {

        hostname:
          "gofile.io",

        href:
          "https://gofile.io/",

        search:
          ""

      }

    }

  };


  const context =
    vm.createContext(
      contextObject,
      {
        name:
          "gofile-website-token"
      }
    );


  try {

    vm.runInContext(
      script,
      context,
      {
        timeout:
          3000
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
    remainder.split("::");


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
      .createHash("sha256")
      .update(raw)
      .digest("hex");


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

    let realLink = null;


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
The folder contents endpoint already gives us the
file metadata. We do NOT require the playable link
here.

The actual GoFile video link will be resolved later,
when Stremio requests the stream.
-------------------------------------------------------
*/

if (
  file.id
) {
  files.push(file);
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
 VALIDATE GOFILE FOLDER
=========================================================

Used by the configuration page. It validates the folder by
actually querying GoFile and counts the video files returned
by the folder contents endpoint. It deliberately does not
resolve every individual video link, keeping configuration
fast even for large folders.
=========================================================
*/

async function validateFolder(
  folderId
) {

  const normalized =
    normalizeFolderId(folderId);

  if (!normalized) {
    throw new Error(
      "ID ou URL de pasta GoFile inválido."
    );
  }

  const account =
    await createAccount();

  const generated =
    await generateWebsiteToken(
      account.token
    );

  const contents =
    await getContentsWithRetry(
      normalized,
      account.token,
      generated.token
    );

  const files =
    extractFiles(contents)
      .map(normalizeFile);

  return {
    folderId: normalized,
    count: files.length,
    files
  };
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
      configured
        ? `com.andre.gofile.${folderId}`
        : "com.andre.gofile",

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
 RESOLVE VIDEO LINK ON DEMAND
=========================================================
*/

async function resolveVideoLink(
  file,
  folderId
) {

  if (
    file &&
    typeof file.link === "string" &&
    file.link.startsWith("http")
  ) {
    return file;
  }

  if (
    !file ||
    !file.id
  ) {
    return null;
  }

  try {

    console.log(
      `[GoFile] Resolving video link: ${file.name}`
    );

    const account =
      await createAccount();

    const generated =
      await generateWebsiteToken(
        account.token
      );

    const fileInfo =
      await getFileLink(
        file.id,
        account.token,
        generated.token,
        folderId
      );

    if (
      !fileInfo ||
      !fileInfo.link
    ) {

      console.log(
        `[GoFile] Unable to resolve link: ${file.name}`
      );

      return null;
    }

    file.link =
      fileInfo.link;

    if (
      fileInfo.thumbnail
    ) {
      file.thumbnail =
        fileInfo.thumbnail;
    }

    if (
      fileInfo.createTime
    ) {
      file.createTime =
        fileInfo.createTime;
    }

    if (
      fileInfo.modTime
    ) {
      file.modTime =
        fileInfo.modTime;
    }

    return file;

  } catch (error) {

    console.error(
      `[GoFile] Error resolving video link:`,
      error.message
    );

    return null;
  }
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

  file =
    await resolveVideoLink(
      file,
      folderId
    );

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

    if (
      /^https?:\/\//i.test(folder)
    ) {

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


  if (!folder)
    return null;


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


function escapeHtml(value) {

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


async function renderConfigurePage(
  req,
  res,
  currentFolder = ""
) {

  const host =
    req.headers.host;


  const protocol =
    req.headers[
      "x-forwarded-proto"
    ] ||
    "https";


  const baseUrl =
    `${protocol}://${host}`;


  const currentPath =
    currentFolder
      ? `/${encodeURIComponent(currentFolder)}/configure`
      : "/configure";


  const requestedFolder =
    normalizeFolderId(
      new URL(
        req.url,
        `http://${host}`
      )
        .searchParams
        .get("folder") ||
      currentFolder
    );


  const action =
    new URL(
      req.url,
      `http://${host}`
    )
      .searchParams
      .get("action");


  let validation =
    null;

  let errorMessage =
    null;


  if (
    action ===
    "validate"
  ) {

    try {

      if (!requestedFolder) {

        throw new Error(
          "Indica o ID ou URL de uma pasta GoFile."
        );

      }


      validation =
        await validateFolder(
          requestedFolder
        );


    } catch (error) {

      console.error(
        "[Configure] Folder validation failed:",
        error.message
      );


      errorMessage =
        error.message ||
        "Não foi possível validar a pasta GoFile.";

    }

  }


  const inputValue =
    requestedFolder ||
    currentFolder ||
    "";


  const escapedInput =
    escapeHtml(
      inputValue
    );


  const escapedError =
    errorMessage
      ? escapeHtml(
          errorMessage
        )
      : "";


  const validationHtml =
    validation
      ? `
<div class="success">
  <strong>Pasta válida.</strong>
  <span>ID: ${escapeHtml(validation.folderId)}</span>
  <span>${validation.count} vídeo(s) encontrado(s).</span>
</div>
<div class="install-box">
  <a class="install" href="stremio://${escapeHtml(host)}/${encodeURIComponent(validation.folderId)}/manifest.json">Instalar no Stremio</a>
</div>`
      : "";


  const errorHtml =
    errorMessage
      ? `<div class="error">${escapedError}</div>`
      : "";


  const loadingHint =
    action === "validate" &&
    !validation &&
    !errorMessage
      ? `<div class="info">A validar a pasta no GoFile...</div>`
      : "";


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
.card{max-width:620px;margin:40px auto;background:#1d1d1d;padding:28px;border-radius:14px;box-shadow:0 10px 35px rgba(0,0,0,.35)}
h1{margin-top:0}
p{line-height:1.5;color:#ddd}
label{display:block;margin:20px 0 8px;font-weight:bold}
input{width:100%;box-sizing:border-box;padding:13px;border-radius:8px;border:1px solid #555;background:#111;color:#fff;font-size:16px}
button,.install{display:block;margin-top:20px;width:100%;box-sizing:border-box;padding:14px;border:0;border-radius:8px;background:#fff;color:#111;font-size:16px;font-weight:bold;cursor:pointer;text-align:center;text-decoration:none}
button:disabled{opacity:.6;cursor:wait}
small{color:#aaa;line-height:1.5}
.error{color:#ff7777;background:#321919;border:1px solid #6b2b2b;padding:12px;border-radius:8px;margin-top:15px}
.success{color:#b9f6c9;background:#17331f;border:1px solid #2e6b3d;padding:14px;border-radius:8px;margin-top:18px;display:flex;flex-direction:column;gap:6px}
.info{color:#ddd;background:#222;border:1px solid #444;padding:12px;border-radius:8px;margin-top:15px}
.install-box{margin-top:2px}
.install{background:#63e68a}
</style>
</head>
<body>
<div class="card">
<h1>GoFile Videos</h1>
<p>Escolhe a pasta GoFile que queres associar a esta instalação do addon.</p>
<form method="GET" action="${escapeHtml(currentPath)}">
<input type="hidden" name="action" value="validate">
<label for="folder">ID ou URL da pasta GoFile</label>
<input id="folder" name="folder" value="${escapedInput}" placeholder="Hg4qUe ou https://gofile.io/d/Hg4qUe" required>
<small>Podes colar diretamente o ID ou o URL completo da pasta.</small>
<button id="validate" type="submit">Validar pasta</button>
</form>
${errorHtml}
${validationHtml}
${loadingHint}
</div>
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
        } = getAddonContext(pathname);


        const activeFolderId =
          folderId || GOFILE_FOLDER;


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
            buildManifest(folderId)
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

            folderCache.delete(
              folderId
            );

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

          if (
            catalogMatch[1] !==
            "gofile-videos"
          ) {

            return sendJson(
              res,
              {
                metas: []
              },
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
                FOLDERS.map(
                  folder => ({
                    name:
                      folder.name,

                    id:
                      folder.id,

                    catalogId:
                      folder.catalogId
                  })
                ),

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
      `Folders: ${FOLDERS.map(
        folder =>
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
