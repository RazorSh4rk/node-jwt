const jwt = require("jsonwebtoken");
const keystoreBuilders = require("./keystoreBuilders");
const UnauthorizedError = require("./unauthorizedError");

//
// private methods
//

function _deny(response, errors) {
  response.status(401);
  response.json({ errors });
}

//
// public methods
//

exports.keystoreBuilders = keystoreBuilders;

exports.extractToken = function extractToken(req) {
  if (req.query && req.query.token) {
    return req.query.token;
  } else if (req.headers && req.headers.authorization) {
    const parts = req.headers.authorization.split(" ");
    if (parts.length === 2) {
      const [scheme, credentials] = parts;
      if (scheme === "Bearer") {
        return credentials;
      }
    }
    throw new UnauthorizedError("Format is Authorization: Bearer [token]");
  }
  return null;
};

exports.lookupKey = async function lookupKey(
  kid,
  keystoreBuilder = keystoreBuilders.fromMany
) {
  const keystore = await keystoreBuilder();
  // eslint-disable-next-line security/detect-object-injection
  return keystore[kid];
};

async function verifyTokenAndReturnPayloadAndKid(token, options) {
  // the `purpose` option aligns with the purpose field in paseto
  // (https://github.com/paragonie/paseto). we use this value to select the
  // appropriate subset of algorithms to support when verifying the token.
  //
  // * a value of "local" (the default here) indicates that the key from the
  //   keystore is a shared secret and is intended to be used with a symmetric
  //   HMAC algorithm such as HS512.
  //
  // * a value of "public" indicates that the key from the keystore is a public
  //   key and is intended to be used with an asymmetric algorithm such as ES512.
  //
  // note that this does not work for a situation where a caller's clients are
  // migrating from hmac to an asymmetric algorithm. in future work we'll want
  // to address that by attaching this value to the key in the keystore instead
  // of to the call site.
  const { keystoreBuilder, purpose } = Object.assign(
    {
      keystoreBuilder: keystoreBuilders.fromMany,
      purpose: "local"
    },
    options
  );

  let algorithms = [];
  switch (purpose) {
    case "local":
      algorithms = ["HS512"];
      break;
    case "public":
      algorithms = ["ES512"];
      break;
  }

  const keystore = await keystoreBuilder();
  const decoded = jwt.decode(token, { complete: true });
  const jwtOptions = { algorithms };
  // if the token has no expiration claim, use the default max age
  if (decoded && decoded.payload && decoded.payload.exp === undefined) {
    jwtOptions.maxAge = process.env.MAX_JWT_AGE;
  }
  const verifiers = [
    function verifyWithKid() {
      try {
        if (decoded && decoded.header && decoded.header.kid) {
          const kid = decoded.header.kid;
          // eslint-disable-next-line security/detect-object-injection
          const key = keystore[kid];
          if (key) {
            const payload = jwt.verify(token, key, jwtOptions);
            return [undefined, payload, kid];
          }
        }
        return ["kid verification failed", undefined, undefined];
      } catch (err) {
        return [err, undefined, undefined];
      }
    },
    function verifyWithDefault() {
      try {
        const key = keystore.default;
        if (key) {
          const payload = jwt.verify(token, key, jwtOptions);
          return [undefined, payload, "default"];
        }
        return ["default verification failed", undefined, undefined];
      } catch (err) {
        return [err, undefined, undefined];
      }
    },
    function verifyWithKeystore() {
      for (const kid in keystore) {
        if (keystore.hasOwnProperty(kid) && kid !== "default") {
          try {
            // eslint-disable-next-line security/detect-object-injection
            const key = keystore[kid];
            const payload = jwt.verify(token, key, jwtOptions);
            return [undefined, payload, kid];
          } catch (err) {
            // ignore key that doesn't work and move on to the next one
          }
        }
      }
      return ["all verification failed", undefined, undefined];
    }
  ];

  let error, payload, kid;
  for (const verifier of verifiers) {
    [error, payload, kid] = verifier();
    // Error "invalid signature" means key didn't match - continue checking
    if (error && error.message && error.message !== "invalid signature") {
      throw new UnauthorizedError(error, "Verification Error");
    }
    if (payload) break;
  }

  if (!payload) {
    throw new UnauthorizedError("Verification Error: No matching keys");
  }

  return [payload, kid];
}

async function verifyTokenAndReturnKid(token, options) {
  const [_, kid] = await verifyTokenAndReturnPayloadAndKid(token, options);
  return kid;
}

exports.verifyToken = async function verifyToken(token, options) {
  const [payload, _] = await verifyTokenAndReturnPayloadAndKid(token, options);
  return payload;
};

exports.required = function required() {
  if (process.env.REQUIRE_AUTH) {
    return (
      process.env.REQUIRE_AUTH.toLowerCase() !== "false" &&
      process.env.REQUIRE_AUTH !== "0"
    );
  }
  return process.env.NODE_ENV === "production";
};

exports.buildMiddleware = function buildMiddleware(options) {
  const { keystoreBuilder, isRequired, purpose } = Object.assign(
    {
      keystoreBuilder: keystoreBuilders.fromMany,
      purpose: "local",
      isRequired: exports.required()
    },
    options
  );
  return async function _authMiddleware(req, res, next) {
    try {
      const token = exports.extractToken(req);
      if (token) {
        res.locals.JWTPayload = jwt.decode(token);
        if (isRequired) {
          res.locals.JWTVerifyingKid = await verifyTokenAndReturnKid(token, {
            keystoreBuilder,
            purpose
          });
        }
      } else if (isRequired) {
        throw new UnauthorizedError("JWT is required");
      }
      next();
    } catch (err) {
      next(err);
    }
  };
};

exports.errorHandler = function errorHandler(err, req, res, next) {
  if (err.name === "UnauthorizedError") {
    _deny(res, err);
  } else {
    next(err);
  }
};

exports.createToken = async function createToken(payload, options) {
  const { kid, keystoreBuilder, algorithm } = Object.assign(
    {
      keystoreBuilder: keystoreBuilders.fromMany,
      algorithm: "HS512"
      // ES512 is more secure, but default to symmetric for simplicity
    },
    options
  );
  try {
    const keystore = await keystoreBuilder();
    const key =
      // eslint-disable-next-line security/detect-object-injection
      keystore[kid] || keystore.default || keystore[Object.keys(keystore)[0]];
    // eslint-disable-next-line security/detect-object-injection
    const signingKid = Object.keys(keystore).find(k => keystore[k] === key);
    return jwt.sign(payload, key, { algorithm, header: { kid: signingKid } });
  } catch (err) {
    throw new UnauthorizedError(err, "Token signing failed");
  }
};
