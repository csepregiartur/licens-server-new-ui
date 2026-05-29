import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { createServer as createViteServer } from "vite";

interface HardwareInfo {
  machine_id?: string;
  hostname?: string;
  os?: string;
  os_version?: string;
  architecture?: string;
  processor?: string;
  cpu_cores?: number;
  mac_addresses?: string;
}

interface LicenseActivation {
  activatedAt: string;
  machineId: string;
  hardwareInfo: HardwareInfo;
  ip: string;
}

interface License {
  licenseKey: string;
  type: "perpetual" | "subscription" | "trial" | "floating" | "node_locked";
  features: {
    premium_feature: boolean;
    [key: string]: boolean;
  };
  active: boolean;
  maxOfflineDays: number;
  exp: string | null;  // ISO string
  notes: string;
  machineId: string | null; // For node_locked, the bound machine
  activations: LicenseActivation[];
}

interface RequestLog {
  id: string;
  timestamp: string;
  type: "activation" | "validation" | "check";
  licenseKey: string;
  machineId: string;
  success: boolean;
  details: string;
  os?: string;
  clientVersion?: string;
}

const PORT = 3000;
const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const KEYS_FILE = path.join(DATA_DIR, "keys.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// -------------------------------------------------------------
// RSA KEY MANAGEMENT
// -------------------------------------------------------------
let privateKeyPem = "";
let publicKeyPem = "";

function loadOrCreateKeys() {
  if (fs.existsSync(KEYS_FILE)) {
    try {
      const keys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8"));
      privateKeyPem = keys.privateKey;
      publicKeyPem = keys.publicKey;
      console.log("✓ Loaded existing RSA-2048 keypair");
      return;
    } catch (e) {
      console.error("Error reading key file, generating new keys...", e);
    }
  }

  console.log("Generating fresh RSA-2048 keypair...");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  privateKeyPem = privateKey;
  publicKeyPem = publicKey;

  fs.writeFileSync(KEYS_FILE, JSON.stringify({ privateKey, publicKey }, null, 2));
  console.log("✓ Saved new RSA-2048 keypair");
}

// -------------------------------------------------------------
// DATABASE (LICENSES) MANAGEMENT
// -------------------------------------------------------------
let licenses: License[] = [];
let requestLogs: RequestLog[] = [];

function loadDatabase() {
  // Try to load licenses
  if (fs.existsSync(DB_FILE)) {
    try {
      const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
      licenses = db.licenses || [];
      console.log(`✓ Loaded ${licenses.length} licenses from database`);
      return;
    } catch (e) {
      console.error("Error reading database, initializing keys...", e);
    }
  }

  // Pre-seed default license key from demo application
  licenses = [
    {
      licenseKey: "E39E-78B7-E5BA-9422",
      type: "perpetual",
      features: {
        premium_feature: true
      },
      active: true,
      maxOfflineDays: 30,
      exp: null,
      notes: "Default perpetual premium key matching clients out-of-the-box.",
      machineId: null,
      activations: []
    },
    {
      licenseKey: "TRIAL-T8A2-X29C-91B1",
      type: "trial",
      features: {
        premium_feature: false
      },
      active: true,
      maxOfflineDays: 7,
      exp: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(), // 14 days trial duration
      notes: "Trial key for testing offline grace periods.",
      machineId: null,
      activations: []
    },
    {
      licenseKey: "FLOAT-B8D1-987A-21E1",
      type: "floating",
      features: {
        premium_feature: true
      },
      active: true,
      maxOfflineDays: 1,
      exp: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      notes: "Floating access license (short 1-day offline tolerance bounds).",
      machineId: null,
      activations: []
    },
    {
      licenseKey: "NODELOCK-29AC-B219-98A1",
      type: "node_locked",
      features: {
        premium_feature: true
      },
      active: true,
      maxOfflineDays: 90,
      exp: null,
      notes: "Node-locked license which bounds permanently to the first machine activated.",
      machineId: null,
      activations: []
    }
  ];

  saveDatabase();
}

function saveDatabase() {
  fs.writeFileSync(DB_FILE, JSON.stringify({ licenses }, null, 2));
}

function logRequest(type: "activation" | "validation" | "check", licenseKey: string, machineId: string, success: boolean, details: string, os?: string, clientVersion?: string) {
  const logEntry: RequestLog = {
    id: crypto.randomBytes(8).toString("hex"),
    timestamp: new Date().toISOString(),
    type,
    licenseKey,
    machineId,
    success,
    details,
    os,
    clientVersion
  };

  requestLogs.unshift(logEntry);
  if (requestLogs.length > 200) {
    requestLogs = requestLogs.slice(0, 200);
  }
}

// -------------------------------------------------------------
// INITIALIZE SETUP
// -------------------------------------------------------------
loadOrCreateKeys();
loadDatabase();

async function startServer() {
  const app = express();

  app.use(express.json());

  // CORS support for development debugging
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // -------------------------------------------------------------
  // ADMINISTRATIVE UI & CONTROL DASHBOARD APIS
  // -------------------------------------------------------------

  // Get current active settings & public RSA Key
  app.get("/api/dashboard/settings", (req, res) => {
    res.json({
      publicKey: publicKeyPem,
      totalLicenses: licenses.length,
      totalLogs: requestLogs.length,
      databasePath: DB_FILE
    });
  });

  // Get list of all licenses
  app.get("/api/dashboard/licenses", (req, res) => {
    res.json(licenses);
  });

  // Get system logs
  app.get("/api/dashboard/logs", (req, res) => {
    res.json(requestLogs);
  });

  // Clear log entries
  app.post("/api/dashboard/logs/clear", (req, res) => {
    requestLogs = [];
    res.json({ success: true });
  });

  // Create a brand new license
  app.post("/api/dashboard/licenses/create", (req, res) => {
    const { type, features, exp, maxOfflineDays, notes } = req.body;

    // Generate a beautiful key like XXXX-XXXX-XXXX-XXXX
    const chars = "0123456789ABCDEF";
    const generateToken = (len: number) => {
      let out = "";
      for (let i = 0; i < len; i++) {
        out += chars[Math.floor(Math.random() * chars.length)];
      }
      return out;
    };
    const licenseKey = `${generateToken(4)}-${generateToken(4)}-${generateToken(4)}-${generateToken(4)}`;

    const newLicense: License = {
      licenseKey,
      type: type || "perpetual",
      features: features || { premium_feature: false },
      active: true,
      maxOfflineDays: Number(maxOfflineDays) || 30,
      exp: exp ? new Date(exp).toISOString() : null,
      notes: notes || "",
      machineId: null,
      activations: []
    };

    licenses.push(newLicense);
    saveDatabase();
    res.json({ success: true, license: newLicense });
  });

  // Toggle activation state
  app.post("/api/dashboard/licenses/toggle", (req, res) => {
    const { licenseKey } = req.body;
    const lic = licenses.find(l => l.licenseKey === licenseKey);
    if (!lic) {
      return res.status(404).json({ error: "License not found" });
    }
    lic.active = !lic.active;
    saveDatabase();
    res.json({ success: true, active: lic.active });
  });

  // Reset activations (revoke machine association)
  app.post("/api/dashboard/licenses/reset", (req, res) => {
    const { licenseKey } = req.body;
    const lic = licenses.find(l => l.licenseKey === licenseKey);
    if (!lic) {
      return res.status(404).json({ error: "License not found" });
    }
    lic.machineId = null;
    lic.activations = [];
    saveDatabase();
    res.json({ success: true, message: "Associated machine IDs and activations are successfully reset." });
  });

  // Delete a license entirely
  app.post("/api/dashboard/licenses/delete", (req, res) => {
    const { licenseKey } = req.body;
    licenses = licenses.filter(l => l.licenseKey !== licenseKey);
    saveDatabase();
    res.json({ success: true });
  });

  // -------------------------------------------------------------
  // CLIENT LICENSE SERVICE APIS (Called by Python Client SDK)
  // -------------------------------------------------------------

  // Endpoint 1: Activation
  app.post("/api/v1/licenses/activate", (req, res) => {
    const { license_key, machine_id, hardware_info } = req.body;

    if (!license_key || !machine_id) {
      return res.status(400).json({
        success: false,
        message: "Missing license_key or machine_id in activation payload"
      });
    }

    const lic = licenses.find(l => l.licenseKey === license_key);

    if (!lic) {
      logRequest("activation", license_key, machine_id, false, "License key not found in storage");
      return res.status(404).json({
        success: false,
        message: "Provided license key is invalid or does not exist."
      });
    }

    if (!lic.active) {
      logRequest("activation", license_key, machine_id, false, "Attempted activation on a suspended license");
      return res.status(403).json({
        success: false,
        message: "Provided license key has been suspended or is currently disabled."
      });
    }

    // Check expiration if not perpetual
    if (lic.type !== "perpetual" && lic.exp) {
      const expirationDate = new Date(lic.exp);
      if (expirationDate < new Date()) {
        logRequest("activation", license_key, machine_id, false, "Attempted activation of an expired license key");
        return res.status(403).json({
          success: false,
          message: "Provided license has expired."
        });
      }
    }

    // Node-locked enforcement
    if (lic.type === "node_locked") {
      if (lic.machineId && lic.machineId !== machine_id) {
        logRequest("activation", license_key, machine_id, false, `Node-locked violation (Already bound to ${lic.machineId})`);
        return res.status(403).json({
          success: false,
          message: "License violates hardware boundary - node locked to another machine."
        });
      }
      // If not yet bound, bind it now!
      if (!lic.machineId) {
        lic.machineId = machine_id;
      }
    }

    // Log the current activation record
    const clientIp = req.headers["x-forwarded-for"]?.toString() || req.socket.remoteAddress || "Unknown";
    const activation: LicenseActivation = {
      activatedAt: new Date().toISOString(),
      machineId: machine_id,
      hardwareInfo: hardware_info || {},
      ip: clientIp
    };

    lic.activations.push(activation);
    saveDatabase();

    // Prepare JWT Token payload
    const payload = {
      license_key: lic.licenseKey,
      license_type: lic.type,
      type: lic.type,
      machine_id: lic.type === "node_locked" ? lic.machineId : machine_id, // lock jwt if node-locked
      features: lic.features,
      max_offline_days: lic.maxOfflineDays,
      created_at: new Date().toISOString()
    };

    // Include expiration in payload if specified
    const expClaim = lic.type !== "perpetual" && lic.exp ? { exp: Math.floor(new Date(lic.exp).getTime() / 1000) } : {};
    const finalPayload = { ...payload, ...expClaim };

    // Sign the token with RS256 algorithm
    try {
      const token = jwt.sign(finalPayload, privateKeyPem, {
        algorithm: "RS256"
      });

      logRequest(
        "activation",
        license_key,
        machine_id,
        true,
        `Activated successfully (${lic.type})`,
        hardware_info?.os || "Unknown",
        "SDK 1.0.0"
      );

      res.json({
        success: true,
        data: {
          token,
          message: `License successfully activated. Welcome to ${lic.type === 'perpetual' ? 'Premium Perpetual' : 'Active'} mode!`
        }
      });
    } catch (err: any) {
      console.error("JWT signing error occurred:", err);
      res.status(500).json({
        success: false,
        message: "Internal cryptographic signing error: " + err.message
      });
    }
  });

  // Endpoint 2: Validation
  app.post("/api/v1/licenses/validate", (req, res) => {
    const { token, machine_id, client_version, client_name, client_info } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "No validation token was provided."
      });
    }

    const sysOS = client_info?.os_name || "Unknown";
    const sysVer = client_version || client_info?.client_version || "SDK 1.0.0";

    try {
      // Decode and verify against our Active RSA public key
      const decoded = jwt.verify(token, publicKeyPem, {
        algorithms: ["RS256"]
      }) as any;

      const licenseKey = decoded.license_key || decoded.license;
      const licenseType = (decoded.license_type || decoded.type || "").toLowerCase();

      // Find matching license key in storage
      const lic = licenses.find(l => l.licenseKey === licenseKey);

      if (!lic) {
        logRequest("validation", licenseKey || "Unknown", machine_id || "Unknown", false, "Validation failed: Signed key missing from DB");
        return res.status(404).json({
          success: false,
          message: "Signed license key could not be verified in server registry."
        });
      }

      if (!lic.active) {
        logRequest("validation", licenseKey, machine_id || "Unknown", false, "Validation rejected: License key has been suspended");
        return res.status(403).json({
          success: false,
          message: "Provided license has been suspended or revoked."
        });
      }

      // Check machine-id binding matching
      if (licenseType === "node_locked") {
        if (lic.machineId !== machine_id || decoded.machine_id !== machine_id) {
          logRequest("validation", licenseKey, machine_id || "Unknown", false, `Hardware validation violation (Expected ${lic.machineId})`);
          return res.status(403).json({
            success: false,
            message: "Hardware machine binding discrepancy - validation failed."
          });
        }
      }

      // Check current expiration from the database
      if (lic.type !== "perpetual" && lic.exp) {
        const expirationDate = new Date(lic.exp);
        if (expirationDate < new Date()) {
          logRequest("validation", licenseKey, machine_id || "Unknown", false, "Validation rejected: License key expired");
          return res.status(403).json({
            success: false,
            message: "License subscription or trial period has elapsed."
          });
        }
      }

      logRequest(
        "validation",
        licenseKey,
        machine_id || "Offline-Check",
        true,
        `Validation successful (${licenseType})`,
        sysOS,
        sysVer
      );

      // Respond back with standard structure expected by _validate_license_with_server
      res.json({
        success: true,
        valid: true,
        data: {
          valid: true,
          type: lic.type,
          license_type: lic.type,
          machine_id: machine_id,
          features: lic.features,
          exp: lic.exp,
          max_offline_days: lic.maxOfflineDays,
          message: "Active license validation verified successfully by the certificate authority state.",
          latest_version: "1.0.0",
          update_policy: "manual",
          download_url: "",
          changelog_url: ""
        }
      });

    } catch (err: any) {
      logRequest("validation", "Parsing Error", machine_id || "Unknown", false, `Signature corruption: ${err.message}`);
      res.status(401).json({
        success: false,
        message: "Token cryptographical signature has expired or is invalid: " + err.message
      });
    }
  });

  // -------------------------------------------------------------
  // VITE MIDDLEWARE SETUP (Express + Vite setup)
  // -------------------------------------------------------------
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`License Server running on: http://localhost:${PORT}`);
    console.log(`Dev app access at Port 3000`);
  });
}

startServer();
