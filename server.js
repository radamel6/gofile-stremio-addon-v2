const http = require("http");
const https = require("https");
const crypto = require("crypto");
const vm = require("vm");
const { URL } = require("url");

/*
=========================================================
 GOFILE → STREMIO ADDON
=========================================================

Para mudar de pasta GoFile:

Render Environment Variable:
GOFILE_FOLDER=Hg4qUe

Exemplo:
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

/*
 * IMPORTANTE:
 * let em vez de const porque a pasta pode ser
 * alterada através da página /configure.
 */
let GOFILE_FOLDER =
  process.env.GOFILE_FOLDER || "xOZ1Mzd3";

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

let folderCache = {
  timestamp: 0,
  files: []
};

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
  websiteToken
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
            `${GOFILE_WEB}/d/${GOFILE_FOLDER}`,

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


    const thumbnail =
      typeof data.thumbnail === "string" &&
      data.thumbnail.startsWith("http")
        ? data.thumbnail
        : null;


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
  websiteToken
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
            `${GOFILE_WEB}/d/${GOFILE_FOLDER}`,

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
  force = false
) {

  const now =
    Date.now();


  if (
    !force &&
    folderCache.timestamp &&
    now -
      folderCache.timestamp
      <
      CACHE_TIME &&
    folderCache.files.length
  ) {

    return folderCache.files;

  }


  console.log(
    `[GoFile] Loading folder ${GOFILE_FOLDER}`
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
      GOFILE_FOLDER,
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


    if (
      !file.link
    ) {

      const fileInfo =
        await getFileLink(
          file.id,
          account.token,
          generated.token
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


  folderCache = {

    timestamp:
      now,

    files:
      sortedFiles

  };


  return sortedFiles;

}


/*
=========================================================
 CONFIGURATION PAGE
=========================================================
*/

function configurationPage() {
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GoFile → Stremio</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 40px 20px;
  background: #111;
  color: #fff;
  font-family: Arial, Helvetica, sans-serif;
}

.container {
  max-width: 600px;
  margin: 0 auto;
  background: #1d1d1d;
  border-radius: 14px;
  padding: 30px;
  box-shadow: 0 10px 40px rgba(0,0,0,.4);
}

h1 {
  margin-top: 0;
  font-size: 28px;
}

p {
  color: #bbb;
  line-height: 1.5;
}

label {
  display: block;
  margin-top: 25px;
  margin-bottom: 8px;
  font-weight: bold;
}

input {
  width: 100%;
  padding: 14px;
  border-radius: 8px;
  border: 1px solid #444;
  background: #111;
  color: #fff;
  font-size: 16px;
}

button {
  width: 100%;
  margin-top: 18px;
  padding: 14px;
  border: 0;
  border-radius: 8px;
  background: #7b3ff2;
  color: #fff;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
}

button:hover {
  background: #8d58f5;
}

button:disabled {
  opacity: .5;
  cursor: wait;
}

#result {
  margin-top: 20px;
  padding: 15px;
  border-radius: 8px;
  display: none;
}

.success {
  background: #173d24;
  color: #7dff9d;
}

.error {
  background: #421d1d;
  color: #ff8c8c;
}

.install {
  background: #e67e22;
}

.install:hover {
  background: #f39c12;
}

.small {
  font-size: 13px;
  color: #888;
}
</style>
</head>

<body>

<div class="container">

  <h1>GoFile → Stremio</h1>

  <p>
    Escolhe a pasta GoFile que queres utilizar no addon.
  </p>

  <label for="folder">
    ID ou URL da pasta GoFile
  </label>

  <input
    id="folder"
    type="text"
    placeholder="Ex: Hg4qUe ou https://gofile.io/d/Hg4qUe"
  />

  <button id="verify">
    Verificar pasta
  </button>

  <div id="result"></div>

</div>

<script>

let selectedFolder = null;

function extractFolderId(value) {

  value = value.trim();

  if (!value) {
    return null;
  }

  // Se foi introduzido um URL GoFile
  if (value.indexOf("gofile.io/d/") !== -1) {

    let part = value.split("gofile.io/d/")[1];

    if (part) {
      part = part.split("/")[0];
      part = part.split("?")[0];
      part = part.split("#")[0];

      if (part) {
        return part;
      }
    }
  }

  // Se foi introduzido diretamente o ID
  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    return value;
  }

  return null;
}


async function verifyFolder() {

  console.log("[Config] verifyFolder iniciado");

  const input = document.getElementById("folder");
  const button = document.getElementById("verify");
  const result = document.getElementById("result");

  if (!input || !button || !result) {

    console.error("[Config] Elementos da página não encontrados");

    return;
  }

  const folderId = extractFolderId(input.value);

  console.log("[Config] Folder ID:", folderId);

  if (!folderId) {

    result.style.display = "block";
    result.className = "error";

    result.innerHTML =
      "<strong>Erro:</strong><br>" +
      "Introduz um ID ou URL GoFile válido.";

    return;
  }

  button.disabled = true;
  button.innerText = "A verificar...";

  result.style.display = "block";
  result.className = "";
  result.innerHTML = "A contactar o servidor...";

  try {

    const url =
      "/api/check-folder?id=" +
      encodeURIComponent(folderId);

    console.log("[Config] Pedido:", url);

    const response = await fetch(url);

    console.log(
      "[Config] HTTP status:",
      response.status
    );

    const text = await response.text();

    console.log(
      "[Config] Resposta:",
      text
    );

    let data;

    try {

      data = JSON.parse(text);

    } catch (parseError) {

      throw new Error(
        "O servidor não devolveu uma resposta JSON válida."
      );
    }

    if (!response.ok || !data.ok) {

      throw new Error(
        data.error ||
        "Não foi possível verificar a pasta."
      );
    }

    selectedFolder = data.folderId;

    result.style.display = "block";
    result.className = "success";

    result.innerHTML =
      "<strong>✓ Pasta encontrada</strong><br><br>" +
      "ID: " + data.folderId + "<br>" +
      "Vídeos encontrados: " + data.videoCount +
      "<br><br>" +
      "<button id='install'>" +
      "Instalar addon no Stremio" +
      "</button>";

    const installButton =
      document.getElementById("install");

    if (installButton) {

      installButton.addEventListener(
        "click",
        installAddon
      );

    }

  } catch (error) {

    console.error(
      "[Config] Erro:",
      error
    );

    selectedFolder = null;

    result.style.display = "block";
    result.className = "error";

    result.innerHTML =
      "<strong>Erro:</strong><br>" +
      error.message;

  } finally {

    button.disabled = false;
    button.innerText = "Verificar pasta";

  }
}


function installAddon() {

  console.log(
    "[Config] installAddon:",
    selectedFolder
  );

  if (!selectedFolder) {

    alert(
      "Primeiro tens de verificar uma pasta GoFile."
    );

    return;
  }

  const manifestUrl =
    window.location.origin +
    "/manifest.json?folder=" +
    encodeURIComponent(selectedFolder);

  const stremioUrl =
    manifestUrl.replace(
      /^https?:\\/\\//,
      "stremio://"
    );

  console.log(
    "[Config] Manifest:",
    manifestUrl
  );

  console.log(
    "[Config] Stremio:",
    stremioUrl
  );

  window.location.href = stremioUrl;
}


/*
====================================================
LIGAR O BOTÃO DEPOIS DE A PÁGINA CARREGAR
====================================================
*/

document.addEventListener(
  "DOMContentLoaded",
  function() {

    console.log(
      "[Config] Página carregada"
    );

    const verifyButton =
      document.getElementById("verify");

    if (!verifyButton) {

      console.error(
        "[Config] Botão Verificar não encontrado"
      );

      return;
    }

    verifyButton.addEventListener(
      "click",
      verifyFolder
    );

    console.log(
      "[Config] Botão Verificar ligado"
    );

  }
);

</script>

</body>
</html>`;
}


/*
=========================================================
 MANIFEST
=========================================================
*/

const manifest = {

  id:
    "com.andre.gofile",

  version:
    "1.3.0",

  name:
    "GoFile Vídeos Alt",

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
        "GoFile Vídeos"

    }

  ],

  idPrefixes: [
    "gofile:"
  ],

  behaviorHints: {

    configurable:
      true,

    configurationRequired:
      false

  }

};


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
  res
) {

  const result = {

    addon:
      "ok",

    folderId:
      GOFILE_FOLDER,

    folderUrl:
      `${GOFILE_WEB}/d/${GOFILE_FOLDER}`,

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
          GOFILE_FOLDER,
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
  file
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
      `${GOFILE_WEB}/d/${GOFILE_FOLDER}`,

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
*/

async function proxyThumbnail(
  req,
  res,
  file
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
      `${GOFILE_WEB}/d/${GOFILE_FOLDER}`,

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
        ===================================================
        CONFIGURATION PAGE
        ===================================================
        */

        if (
          pathname ===
          "/configure"
        ) {

          res.statusCode =
            200;

          res.setHeader(
            "Content-Type",
            "text/html; charset=utf-8"
          );

          return res.end(
            configurationPage()
          );

        }


        /*
        ===================================================
        CHECK GOFILE FOLDER
        ===================================================
        */

        if (
          pathname ===
          "/api/check-folder"
        ) {

          const requestedFolder =
            parsed.searchParams.get(
              "id"
            );


          if (
            !requestedFolder
          ) {

            return sendJson(
              res,
              {

                ok:
                  false,

                error:
                  "Folder ID não fornecido."

              },
              400
            );

          }


          const previousFolder =
            GOFILE_FOLDER;


          try {

            console.log(
              `[Config] Verifying GoFile folder: ${requestedFolder}`
            );


            /*
            -------------------------------------------------
            Temporariamente selecionamos a pasta pedida.
            loadFolder(true) usa exatamente a mesma lógica
            de autenticação que já funciona no addon.
            -------------------------------------------------
            */

            GOFILE_FOLDER =
              requestedFolder;


            folderCache = {

              timestamp:
                0,

              files:
                []

            };


            const files =
              await loadFolder(
                true
              );


            console.log(
              `[Config] Folder selected: ${GOFILE_FOLDER}`
            );


            return sendJson(
              res,
              {

                ok:
                  true,

                folderId:
                  GOFILE_FOLDER,

                folderUrl:
                  `${GOFILE_WEB}/d/${GOFILE_FOLDER}`,

                videoCount:
                  files.length

              }
            );


          } catch (error) {

            /*
            -------------------------------------------------
            Se a verificação falhar, voltamos à pasta
            anterior para não deixar o addon num estado
            inválido.
            -------------------------------------------------
            */

            GOFILE_FOLDER =
              previousFolder;


            folderCache = {

              timestamp:
                0,

              files:
                []

            };


            console.error(
              "[Config] Folder verification failed:",
              error
            );


            return sendJson(
              res,
              {

                ok:
                  false,

                error:
                  error.message ||
                  "Erro ao verificar a pasta."

              },
              500
            );

          }

        }


        /*
        ---------------------------------------------------
        MANIFEST
        ---------------------------------------------------
        */

        if (
          pathname ===
          "/manifest.json"
        ) {

          const requestedFolder =
            parsed.searchParams.get(
              "folder"
            );


          /*
          -------------------------------------------------
          Quando o Stremio instala:

          /manifest.json?folder=Hg4qUe

          a pasta passa a ser a pasta global do addon.
          -------------------------------------------------
          */

          if (
            requestedFolder
          ) {

            console.log(
              `[Manifest] Selected folder: ${requestedFolder}`
            );


            GOFILE_FOLDER =
              requestedFolder;


            folderCache = {

              timestamp:
                0,

              files:
                []

            };

          }


          return sendJson(
            res,
            manifest
          );

        }


        /*
        ---------------------------------------------------
        DIAGNOSTIC
        ---------------------------------------------------
        */

        if (
          pathname ===
          "/diagnostico"
        ) {

          return await diagnostic(
            res
          );

        }


        /*
        ---------------------------------------------------
        TEST LINK
        ---------------------------------------------------
        */

        if (
          pathname ===
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
          pathname ===
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
                generated.token
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
          pathname ===
          "/refresh"
        ) {

          folderCache = {

            timestamp:
              0,

            files:
              []

          };


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
          pathname ===
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
          pathname.match(
            /^\/catalog\/other\/gofile-videos(?:\.json)?$/
          );


        if (
          catalogMatch
        ) {

          const files =
            await loadFolder();


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
                    `/thumbnail/` +
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

                  poster

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
          pathname.match(
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
            await loadFolder();


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
                `/thumbnail/` +
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

                poster

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
          pathname.match(
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
            await loadFolder();


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
            file
          );

        }


        /*
        ===================================================
        VIDEO PROXY
        ===================================================
        */

        const proxyMatch =
          pathname.match(
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
            await loadFolder();


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
            file
          );

        }


        /*
        ===================================================
        STREAM
        ===================================================
        */

        const streamMatch =
          pathname.match(
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
            await loadFolder();


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
            `/proxy/` +
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
          pathname === "/" ||
          pathname === ""
        ) {

          return sendJson(
            res,
            {

              addon:
                "ok",

              name:
                "GoFile Videos",

              folder:
                GOFILE_FOLDER,

              sort:
                GOFILE_SORT,

              configure:
                "/configure",

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
      `Folder: ${GOFILE_FOLDER}`
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
      "Configuration page enabled"
    );

    console.log(
      "=========================================="
    );

  }
);
