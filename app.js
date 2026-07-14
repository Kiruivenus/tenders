const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

// Initialize local storage directories for file uploads and audit logs
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const LOGS_DIR = path.join(__dirname, 'logs');

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Generate or fetch secret token for HMAC signed download links
const API_SECRET = process.env.API_SECRET || crypto.randomBytes(32).toString('hex');
const LINK_EXPIRATION_TIME = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

// Validate required SMTP environment variables
const requiredEnvVars = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'RECEIVER_EMAIL'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
    const errorMsg = `CRITICAL CONFIGURATION ERROR: Missing required SMTP environment variables: ${missingVars.join(', ')}`;
    console.error('==================================================');
    console.error(errorMsg);
    console.error('Please ensure all required variables are set in your environment or .env file.');
    console.error('==================================================');
    if (!process.env.VERCEL) {
        process.exit(1);
    } else {
        throw new Error(errorMsg);
    }
}

// Configure the pooled Nodemailer SMTP transporter for Zoho Mail
const transporter = nodemailer.createTransport({
    pool: true, // Enable connection pooling
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true', // false for STARTTLS (587)
    requireTLS: true, // Automatically enable requireTLS
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Verify SMTP connection pool on startup
transporter.verify((error, success) => {
    if (error) {
        console.error('==================================================');
        console.error('SMTP Connection Validation Failed:');
        console.error(`- Reason: ${error.message}`);
        console.error('- Recommended action: Verify SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS values.');
        console.error('==================================================');
    } else {
        console.log('SMTP Connection Pool successfully verified and ready to dispatch emails.');
    }
});

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS middleware to support clients running on other ports (e.g. Live Server on 5500)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Normalize paths for subdirectory hosting on cPanel (e.g., /tenders/style.css -> /style.css)
app.use((req, res, next) => {
    const knownRoutes = ['/submit-tender', '/index.html', '/style.css', '/portal.js', '/proposal.docx'];
    const cleanPath = req.path.replace(/\/$/, '');
    
    const matchedRoute = knownRoutes.find(route => req.path.endsWith(route));
    if (matchedRoute) {
        req.url = matchedRoute;
    } else if (cleanPath === '' || !cleanPath.includes('.')) {
        req.url = '/index.html';
    }
    next();
});

// Setup Multer to store uploaded files in memory
// This avoids writing temp files to disk, allowing direct SMTP streaming
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedExtensions = /pdf|docx/i;
        const extName = allowedExtensions.test(path.extname(file.originalname));
        
        // Mimetypes validation (PDF & Word DOCX)
        const allowedMimeTypes = [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ];
        const mimeTypeValid = allowedMimeTypes.includes(file.mimetype);

        if (extName && mimeTypeValid) {
            return cb(null, true);
        }
        cb(new Error('Only PDF and DOCX documents are allowed.'));
    }
});

// Serve static web files from the current folder (index.html, style.css, portal.js)
app.use(express.static(path.join(__dirname)));

// Filename Sanitizer to prevent traversal and shell exploits
function sanitizeFilename(filename) {
    if (!filename) return 'unnamed_file';
    let clean = path.basename(filename);
    clean = clean.replace(/[^a-zA-Z0-9.-]/g, '_');
    return clean;
}

// Generate signed URL for attachments > 5MB
function generateSignedUrl(fileId, expiresAt, req) {
    const data = `${fileId}:${expiresAt}`;
    const signature = crypto.createHmac('sha256', API_SECRET).update(data).digest('hex');
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    return `${baseUrl}/download-tender/${fileId}?expires=${expiresAt}&sig=${signature}`;
}

// Verify signed URL signature and expiration
function verifySignedUrl(fileId, expiresAt, signature) {
    const now = Date.now();
    if (now > parseInt(expiresAt, 10)) {
        return { valid: false, reason: 'expired' };
    }
    const data = `${fileId}:${expiresAt}`;
    const expectedSignature = crypto.createHmac('sha256', API_SECRET).update(data).digest('hex');
    if (signature !== expectedSignature) {
        return { valid: false, reason: 'invalid_signature' };
    }
    return { valid: true };
}

// Secure file download endpoint for large attachments
app.get('/download-tender/:fileId', (req, res) => {
    try {
        const { fileId } = req.params;
        const { expires, sig } = req.query;
        
        if (!fileId || !expires || !sig) {
            return res.status(400).send('Bad Request: Missing signed parameters.');
        }
        
        const verification = verifySignedUrl(fileId, expires, sig);
        if (!verification.valid) {
            if (verification.reason === 'expired') {
                return res.status(410).send('Link Expired: This download link is no longer valid (expired after 7 days).');
            } else {
                return res.status(403).send('Forbidden: Invalid signature.');
            }
        }
        
        // Prevent path traversal
        const safeFileId = path.basename(fileId);
        const filePath = path.join(UPLOADS_DIR, safeFileId);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).send('Not Found: The requested proposal file does not exist.');
        }
        
        // Retrieve original metadata (filename)
        let originalName = safeFileId;
        const metaPath = `${filePath}.json`;
        if (fs.existsSync(metaPath)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                if (meta && meta.originalname) {
                    originalName = meta.originalname;
                }
            } catch (err) {
                console.error('Error reading metadata file:', err);
            }
        }
        
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        
    } catch (err) {
        console.error('Secure file download processing error:', err);
        res.status(500).send('Internal Server Error processing file download.');
    }
});

// Helper to generate reference ID
function generateReference() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let rand = '';
    for (let i = 0; i < 6; i++) {
        rand += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `APX-2026-${rand}`;
}

// Helper to escape HTML characters for security
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Generate RFC-compliant unique Message-ID
function generateUniqueMessageId(domain = 'dolagroup.info') {
    const randomHex = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();
    return `<${timestamp}.${randomHex}@${domain}>`;
}

// Append structured audit log entries
function logEmailDelivery(record) {
    try {
        const logFilePath = path.join(LOGS_DIR, 'email_deliveries.jsonl');
        const logLine = JSON.stringify({
            timestamp: new Date().toISOString(),
            ...record
        }) + '\n';
        fs.appendFileSync(logFilePath, logLine, 'utf8');
    } catch (err) {
        console.error('[LOGGER ERROR] Failed to record email delivery metrics:', err);
    }
}

// Mail sender with exponential backoff retry for transient errors
async function sendMailWithRetry(mailOptions, maxRetries = 3) {
    let attempts = 0;
    let delay = 1000; // 1 second initial delay
    
    while (attempts < maxRetries) {
        try {
            attempts++;
            const info = await transporter.sendMail(mailOptions);
            return { success: true, info, attempts };
        } catch (err) {
            console.warn(`[SMTP WARNING] Send attempt ${attempts}/${maxRetries} failed: ${err.message}`);
            
            // Check if error is transient (e.g. auth failed/5xx is permanent, timeouts/resets are transient)
            const isTransient = !err.message.includes('Auth') && 
                               !err.message.includes('Authentication') && 
                               !err.message.includes('535') &&
                               !err.responseCode?.toString().startsWith('5');
            
            if (attempts >= maxRetries || !isTransient) {
                return { success: false, error: err, attempts };
            }
            
            // Exponential backoff delay
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
}

// Template Compilers for Procurement Notifications
function getProcurementHtml(vars) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Tender Proposal Submitted</title>
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    table { border-collapse: collapse !important; }
    body { height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: #f7f8fa; }
    a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; font-size: inherit !important; font-family: inherit !important; font-weight: inherit !important; line-height: inherit !important; }
  </style>
</head>
<body style="background-color: #f7f8fa; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td align="center" style="padding: 30px 10px;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.03);">
          <!-- Header -->
          <tr>
            <td style="padding: 24px 32px; background-color: #1e3a8a; border-top-left-radius: 11px; border-top-right-radius: 11px; text-align: left;">
              <table border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td style="vertical-align: middle;">
                    <!-- SVG Shield Logo -->
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 8px; display: inline-block;">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    </svg>
                    <h1 style="color: #ffffff; font-size: 20px; font-weight: 700; margin: 0; display: inline-block; vertical-align: middle; font-family: inherit;">Dola Group</h1>
                    <span style="color: #93c5fd; font-size: 11px; font-weight: 600; display: block; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.05em;">Secure Procurement Platform</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body Content -->
          <tr>
            <td style="padding: 32px 32px 24px 32px; color: #0f172a;">
              <h2 style="font-size: 18px; font-weight: 700; margin: 0 0 16px 0; color: #1e3a8a;">New Tender Proposal Submitted</h2>
              <p style="font-size: 14px; line-height: 1.6; margin: 0 0 24px 0; color: #334155;">A new tender proposal has been registered on the Dola Group Procurement Portal. Please review the details below:</p>
              
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
                <tr>
                  <td colspan="2" style="background-color: #f8fafc; font-size: 13px; font-weight: 700; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; border-top-left-radius: 7px; border-top-right-radius: 7px; color: #1e3a8a; text-transform: uppercase; letter-spacing: 0.05em;">Tender Summary</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; width: 40%; border-bottom: 1px solid #f1f5f9;">Reference ID</td>
                  <td style="padding: 10px 16px; font-size: 13px; font-family: monospace; font-weight: 700; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.refCode}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Tender Title</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.title}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Category</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.category}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Budget Range</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.budget}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Deadline Date</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.deadline}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Applicant Name</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.fullname}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Company Name</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.company}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Email Address</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;"><a href="mailto:${vars.email}" style="color: #3b82f6; text-decoration: none;">${vars.email}</a></td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Phone Number</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.phone}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Preferred Contact</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.preferred_contact}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom-left-radius: 7px;">Tender Document</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom-right-radius: 7px;">${vars.fileStatus}</td>
                </tr>
              </table>

              <h3 style="font-size: 14px; font-weight: 700; color: #1e3a8a; margin: 0 0 10px 0;">Proposal Description</h3>
              <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; font-size: 13px; color: #334155; line-height: 1.6; white-space: pre-wrap;">${vars.description}</div>
              
              ${vars.downloadButtonMarkup}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: #f8fafc; border-bottom-left-radius: 11px; border-bottom-right-radius: 11px; border-top: 1px solid #e2e8f0; text-align: center; color: #64748b; font-size: 12px; line-height: 1.5;">
              <strong style="color: #0f172a;">Dola Group Ltd</strong><br>
              <a href="https://dolagroup.info" style="color: #3b82f6; text-decoration: none; font-weight: 600;">Official Website</a> &nbsp;|&nbsp; 
              <a href="mailto:tenders@dolagroup.info" style="color: #3b82f6; text-decoration: none; font-weight: 600;">tenders@dolagroup.info</a><br><br>
              &copy; 2026 Dola Group. All rights reserved.<br>
              <span style="font-size: 11px; color: #94a3b8;">This email was automatically generated by the Dola Group Procurement Portal. <a href="https://dolagroup.info/privacy" style="color: #64748b; text-decoration: underline;">Privacy Policy</a>.</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function getProcurementText(vars) {
    return `DOLA GROUP - SECURE PROCUREMENT PLATFORM
==================================================
NEW TENDER PROPOSAL SUBMITTED

A new tender proposal has been registered on the Dola Group Procurement Portal.

TENDER SUMMARY
--------------------------------------------------
Reference ID: ${vars.refCode}
Tender Title: ${vars.title}
Category: ${vars.category}
Budget Range: ${vars.budget}
Deadline Date: ${vars.deadline}
Applicant Name: ${vars.fullname}
Company Name: ${vars.company}
Email Address: ${vars.email}
Phone Number: ${vars.phone}
Preferred Contact: ${vars.preferred_contact}
Tender Document: ${vars.fileStatus}

PROPOSAL DESCRIPTION:
--------------------------------------------------
${vars.description}

${vars.downloadLinkText}

--------------------------------------------------
Dola Group Ltd | Website: https://dolagroup.info | Inquiries: tenders@dolagroup.info
Copyright (C) 2026 Dola Group. All rights reserved.
This email was automatically generated by the Dola Group Procurement Portal.`;
}

// Template Compilers for Applicant Confirmations
function getApplicantHtml(vars) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tender Submission Confirmation</title>
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    table { border-collapse: collapse !important; }
    body { height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: #f7f8fa; }
    a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; font-size: inherit !important; font-family: inherit !important; font-weight: inherit !important; line-height: inherit !important; }
  </style>
</head>
<body style="background-color: #f7f8fa; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td align="center" style="padding: 30px 10px;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.03);">
          <!-- Header -->
          <tr>
            <td style="padding: 24px 32px; background-color: #1e3a8a; border-top-left-radius: 11px; border-top-right-radius: 11px; text-align: left;">
              <table border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td style="vertical-align: middle;">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 8px; display: inline-block;">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    </svg>
                    <h1 style="color: #ffffff; font-size: 20px; font-weight: 700; margin: 0; display: inline-block; vertical-align: middle; font-family: inherit;">Dola Group</h1>
                    <span style="color: #93c5fd; font-size: 11px; font-weight: 600; display: block; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.05em;">Secure Procurement Platform</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body Content -->
          <tr>
            <td style="padding: 32px 32px 24px 32px; color: #0f172a;">
              <p style="font-size: 15px; font-weight: 600; color: #0f172a; margin: 0 0 12px 0;">Dear ${vars.fullname},</p>
              <p style="font-size: 14px; line-height: 1.6; margin: 0 0 24px 0; color: #334155;">We have successfully received your tender proposal. Your submission has been securely registered in our system and is currently marked for evaluation.</p>
              
              <!-- Status Badge -->
              <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 6px; padding: 12px 16px; margin-bottom: 24px; text-align: center;">
                <span style="font-size: 14px; font-weight: 700; color: #047857; display: inline-flex; align-items: center; gap: 8px;">
                  <span style="display: inline-block; width: 18px; height: 18px; background-color: #10b981; color: #ffffff; text-align: center; border-radius: 50%; line-height: 18px; font-size: 11px; font-weight: 900;">✔</span>
                  Successfully Received
                </span>
              </div>

              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
                <tr>
                  <td colspan="2" style="background-color: #f8fafc; font-size: 13px; font-weight: 700; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; border-top-left-radius: 7px; border-top-right-radius: 7px; color: #1e3a8a; text-transform: uppercase; letter-spacing: 0.05em;">Submission Receipt</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; width: 40%; border-bottom: 1px solid #f1f5f9;">Reference Number</td>
                  <td style="padding: 10px 16px; font-size: 13px; font-family: monospace; font-weight: 700; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.refCode}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Tender Title</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.title}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Category</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.category}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Submission Date</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.submissionDate}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Submission Deadline</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.deadline}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 1px solid #f1f5f9;">Uploaded Document</td>
                  <td style="padding: 10px 16px; font-size: 13px; color: #0f172a; border-bottom: 1px solid #f1f5f9;">${vars.fileStatus}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 600; color: #64748b; border-bottom-left-radius: 7px;">Status</td>
                  <td style="padding: 10px 16px; font-size: 13px; font-weight: 700; color: #059669; border-bottom-right-radius: 7px;">✔ Successfully Received</td>
                </tr>
              </table>

              <!-- Next Steps Section -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <h4 style="font-size: 14px; font-weight: 700; color: #1e3a8a; margin: 0 0 12px 0;">What happens next?</h4>
                    <ol style="font-size: 13px; line-height: 1.6; color: #475569; margin: 0; padding-left: 20px;">
                      <li style="margin-bottom: 8px;"><strong>Secure Storage:</strong> Your proposal files are now stored securely in our document repository and cannot be altered.</li>
                      <li style="margin-bottom: 8px;"><strong>Evaluation:</strong> Our procurement evaluation committee will review all submissions after the closing deadline.</li>
                      <li style="margin-bottom: 8px;"><strong>Clarification:</strong> We will contact you using your preferred contact method (<strong>${vars.preferred_contact}</strong>) if our review team requires any clarification.</li>
                      <li><strong>Decision:</strong> Formal notifications of award decisions will be distributed after evaluation is completed.</li>
                    </ol>
                  </td>
                </tr>
              </table>
              
              ${vars.downloadButtonMarkup}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: #f8fafc; border-bottom-left-radius: 11px; border-bottom-right-radius: 11px; border-top: 1px solid #e2e8f0; text-align: center; color: #64748b; font-size: 12px; line-height: 1.5;">
              <strong style="color: #0f172a;">Dola Group Ltd</strong><br>
              <a href="https://dolagroup.info" style="color: #3b82f6; text-decoration: none; font-weight: 600;">Official Website</a> &nbsp;|&nbsp; 
              <a href="mailto:tenders@dolagroup.info" style="color: #3b82f6; text-decoration: none; font-weight: 600;">tenders@dolagroup.info</a><br><br>
              &copy; 2026 Dola Group. All rights reserved.<br>
              <span style="font-size: 11px; color: #94a3b8;">This email was automatically generated by the Dola Group Procurement Portal. <a href="https://dolagroup.info/privacy" style="color: #64748b; text-decoration: underline;">Privacy Policy</a>.</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function getApplicantText(vars) {
    return `DOLA GROUP - SECURE PROCUREMENT PLATFORM
==================================================
TENDER SUBMISSION RECEIPT

Dear ${vars.fullname},

We have successfully received your tender proposal. Your submission has been securely registered in our system and is currently marked for evaluation.

SUBMISSION SUMMARY
--------------------------------------------------
Reference Number: ${vars.refCode}
Tender Title: ${vars.title}
Category: ${vars.category}
Submission Date: ${vars.submissionDate}
Submission Deadline: ${vars.deadline}
Uploaded Document: ${vars.fileStatus}
Status: Successfully Received

WHAT HAPPENS NEXT?
--------------------------------------------------
1. Secure Storage: Your proposal files are now stored securely in our document repository and cannot be altered.
2. Evaluation: Our procurement evaluation committee will review all submissions after the closing deadline.
3. Clarification: We will contact you using your preferred contact method (${vars.preferred_contact}) if our review team requires any clarification.
4. Decision: Formal notifications of award decisions will be distributed after evaluation is completed.

${vars.downloadLinkText}

--------------------------------------------------
Dola Group Ltd | Website: https://dolagroup.info | Inquiries: tenders@dolagroup.info
Copyright (C) 2026 Dola Group. All rights reserved.
This email was automatically generated by the Dola Group Procurement Portal.`;
}

// ----------------------------------------------------
// POST API Endpoint: /submit-tender
// ----------------------------------------------------
// ----------------------------------------------------
app.post('/submit-tender', upload.single('tender_file'), async (req, res) => {
    const deliveryRecord = {
        recipient: '',
        referenceNumber: '',
        messageId: '',
        status: 'Failed',
        retryCount: 0,
        smtpResponse: ''
    };
    try {
        const {
            fullname,
            company,
            email,
            phone,
            title,
            category,
            budget,
            deadline,
            description,
            preferred_contact
        } = req.body;

        // Basic server-side validations
        if (!fullname || !company || !email || !phone || !title || !category || !deadline || !description || !preferred_contact) {
            return res.status(400).json({ success: false, message: 'All required fields must be filled.' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ success: false, message: 'Invalid email address provided.' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Tender proposal document file is required.' });
        }

        const refCode = generateReference();


        deliveryRecord.referenceNumber = refCode;
        deliveryRecord.recipient = email;

        // Sanitize filename to prevent directory traversal
        const sanitizedFilename = sanitizeFilename(req.file.originalname);

        // Handle attachment sizing (5MB threshold logic)
        let hasLargeAttachment = false;
        let attachmentUrl = '';
        const FILE_SIZE_THRESHOLD = 5 * 1024 * 1024; // 5MB

        if (req.file.size > FILE_SIZE_THRESHOLD) {
            hasLargeAttachment = true;
            const fileUuid = crypto.randomUUID();
            const extension = path.extname(sanitizedFilename);
            const fileId = `${fileUuid}${extension}`;
            
            const attachmentPath = path.join(UPLOADS_DIR, fileId);
            const metaPath = `${attachmentPath}.json`;
            
            // Save file and metadata to local uploads directory
            fs.writeFileSync(attachmentPath, req.file.buffer);
            fs.writeFileSync(metaPath, JSON.stringify({
                originalname: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size,
                uploadedAt: new Date().toISOString()
            }), 'utf8');
            
            // Generate secure HMAC signed URL valid for 7 days
            const expiresAt = Date.now() + LINK_EXPIRATION_TIME;
            attachmentUrl = generateSignedUrl(fileId, expiresAt, req);
            console.log(`[Large attachment stored] File size (${(req.file.size / (1024 * 1024)).toFixed(2)} MB) > 5MB. Signed URL generated: ${attachmentUrl}`);
        }

        // Setup attachment configurations
        const mailAttachments = [];
        let fileStatus = '';
        let downloadButtonMarkup = '';
        let downloadLinkText = '';
        
        if (hasLargeAttachment) {
            fileStatus = `Stored Securely (Download link attached below)`;
            downloadLinkText = `SECURE DOWNLOAD LINK (Expires in 7 days):\n${attachmentUrl}`;
            downloadButtonMarkup = `
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top: 24px; margin-bottom: 8px;">
                <tr>
                  <td align="center">
                    <table border="0" cellpadding="0" cellspacing="0" style="margin: 0 auto;">
                      <tr>
                        <td align="center" style="background-color: #059669; border-radius: 6px;">
                          <a href="${attachmentUrl}" target="_blank" style="display: inline-block; padding: 12px 24px; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none; border-radius: 6px; border: 1px solid #059669; font-family: sans-serif; letter-spacing: 0.02em;">Download Proposal File (Secure Link)</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-top: 8px; font-size: 11px; color: #94a3b8;">
                    Link expires in 7 days. Secured by Dola Group.
                  </td>
                </tr>
              </table>`;
        } else {
            fileStatus = `${req.file.originalname} (Attached directly, ${(req.file.size / (1024 * 1024)).toFixed(2)} MB)`;
            mailAttachments.push({
                filename: req.file.originalname,
                content: req.file.buffer
            });
        }

        // Escape input variables to prevent HTML/XSS injection
        const escapedVars = {
            fullname: escapeHtml(fullname),
            company: escapeHtml(company),
            email: escapeHtml(email),
            phone: escapeHtml(phone),
            title: escapeHtml(title),
            category: escapeHtml(category),
            budget: budget ? escapeHtml(budget) : 'Not specified',
            deadline: escapeHtml(deadline),
            preferred_contact: escapeHtml(preferred_contact),
            description: escapeHtml(description),
            refCode: escapeHtml(refCode),
            submissionDate: new Date().toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            }),
            fileStatus: escapeHtml(fileStatus),
            downloadButtonMarkup,
            downloadLinkText
        };

        // Render HTML and plain text bodies
        const procurementHtml = getProcurementHtml(escapedVars);
        const procurementText = getProcurementText(escapedVars);
        const applicantHtml = getApplicantHtml(escapedVars);
        const applicantText = getApplicantText(escapedVars);

        // Define unique Message-ID headers
        const msgIdProcurement = generateUniqueMessageId();
        const msgIdApplicant = generateUniqueMessageId();
        deliveryRecord.messageId = msgIdProcurement;

        const mailOptions = {
            from: `"${company} via Dola Group Tender Portal" <${process.env.SMTP_USER}>`,
            to: process.env.RECEIVER_EMAIL,
            replyTo: email,
            subject: `Tender Submission Receipt - ${title} [${refCode}]`,
            html: procurementHtml,
            text: procurementText,
            attachments: mailAttachments,
            headers: {
                'Message-ID': msgIdProcurement,
                'X-Mailer': 'DolaGroup-Procurement-Mailer/2.0',
                'Organization': 'Dola Group',
                'Auto-Submitted': 'auto-generated',
                'Precedence': 'transactional',
                'Priority': 'normal'
            }
        };

        // Send email to procurement team with retry capabilities
        const result = await sendMailWithRetry(mailOptions);
        deliveryRecord.retryCount = result.attempts - 1;

        if (!result.success) {
            deliveryRecord.smtpResponse = result.error.message;
            logEmailDelivery(deliveryRecord);
            throw result.error;
        }

        deliveryRecord.status = 'Delivered';
        deliveryRecord.smtpResponse = result.info.response;
        logEmailDelivery(deliveryRecord);
        console.log(`[SMTP success] Procurement Email Sent successfully. Message ID: ${result.info.messageId}`);

        // Send confirmation receipt email to the applicant (independently caught)
        try {
            const confirmationOptions = {
                from: `"Dola Group" <${process.env.SMTP_USER}>`,
                to: email,
                subject: `Tender Submission Confirmation - ${title} [${refCode}]`,
                html: applicantHtml,
                text: applicantText,
                attachments: mailAttachments,
                headers: {
                    'Message-ID': msgIdApplicant,
                    'X-Mailer': 'DolaGroup-Procurement-Mailer/2.0',
                    'Organization': 'Dola Group',
                    'Auto-Submitted': 'auto-generated',
                    'Precedence': 'transactional',
                    'Priority': 'normal'
                }
            };
            const applicantResult = await sendMailWithRetry(confirmationOptions);
            if (applicantResult.success) {
                console.log(`[SMTP success] Applicant Confirmation Email Sent successfully. Message ID: ${applicantResult.info.messageId}`);
            } else {
                console.error('[SMTP failure] Failed to dispatch confirmation email to applicant:', applicantResult.error.message);
            }
        } catch (confirmErr) {
            console.error('[SMTP failure] Failed to dispatch confirmation email to applicant:', confirmErr);
        }

        return res.status(200).json({
            success: true,
            reference: refCode,
            message: 'Tender proposal submitted and email sent.'
        });

    } catch (err) {
        console.error('SMTP Processing Error:', err);
        return res.status(500).json({
            success: false,
            message: `Internal Server Error during email transmission: ${err.message}`
        });
    }
});

// Global Error Handler for Multer upload issues
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ success: false, message: 'The uploaded file exceeds the 10MB limit.' });
        }
        return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });
    }
    if (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
    next();
});

// Start listening
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`==================================================`);
        console.log(`Tender Submission Portal listening on http://localhost:${PORT}`);
        console.log(`Press Ctrl+C to terminate server.`);
        console.log(`==================================================`);
    });
}

module.exports = app;
