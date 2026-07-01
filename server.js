const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

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

// Serve static web files from the current folder (index.html, style.css, app.js)
app.use(express.static(path.join(__dirname)));

// Helper to generate reference ID
function generateReference() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let rand = '';
    for (let i = 0; i < 6; i++) {
        rand += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `APX-2026-${rand}`;
}

// SMTP Transporter setup
let transporter;

async function getTransporter() {
    if (transporter) return transporter;

    // Check if user has configured custom SMTP environment variables
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
        console.log('Using configured custom SMTP server:', process.env.SMTP_HOST);
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
    } else {
        // Fallback for development: Auto-generate an Ethereal SMTP test account
        console.log('No SMTP configuration detected. Generating a temporary Ethereal SMTP account...');
        const testAccount = await nodemailer.createTestAccount();
        console.log('Ethereal test account generated:');
        console.log(`- User: ${testAccount.user}`);
        console.log(`- Pass: ${testAccount.pass}`);
        
        transporter = nodemailer.createTransport({
            host: testAccount.smtp.host,
            port: testAccount.smtp.port,
            secure: testAccount.smtp.secure,
            auth: {
                user: testAccount.user,
                pass: testAccount.pass
            }
        });
    }
    return transporter;
}

// ----------------------------------------------------
// POST API Endpoint: /submit-tender
// ----------------------------------------------------
app.post('/submit-tender', upload.single('tender_file'), async (req, res) => {
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

        // Build HTML formatted email body
        const emailHTML = `
            <h2>New Tender Proposal Submission</h2>
            <p>A new tender proposal has been submitted through the portal.</p>
            
            <table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; border-color: #E2E8F0; width: 100%; max-width: 600px;">
                <tr style="background-color: #F8FAFC;">
                    <th colspan="2" style="text-align: left; font-size: 1.1em; color: #0B1F3B; padding: 10px;">Submission Details</th>
                </tr>
                <tr>
                    <td style="width: 35%; font-weight: bold;">Reference ID:</td>
                    <td style="font-family: monospace; font-weight: bold; color: #0B1F3B;">${refCode}</td>
                </tr>
                <tr>
                    <td style="font-weight: bold;">Tender Title:</td>
                    <td>${title}</td>
                </tr>
                <tr>
                    <td style="font-weight: bold;">Category:</td>
                    <td>${category}</td>
                </tr>
                <tr>
                    <td style="font-weight: bold;">Budget Range:</td>
                    <td>${budget || 'Not specified'}</td>
                </tr>
                <tr>
                    <td style="font-weight: bold;">Deadline Date:</td>
                    <td>${deadline}</td>
                </tr>
                <tr style="background-color: #F8FAFC;">
                    <th colspan="2" style="text-align: left; font-size: 1.1em; color: #0B1F3B; padding: 10px;">Contact Information</th>
                </tr>
                <tr>
                    <td style="font-weight: bold;">Full Name:</td>
                    <td>${fullname}</td>
                </tr>
                <tr>
                    <td style="font-weight: bold;">Company Name:</td>
                    <td>${company}</td>
                </tr>
                <tr>
                    <td style="font-weight: bold;">Email:</td>
                    <td><a href="mailto:${email}">${email}</a></td>
                </tr>
                <tr>
                    <td style="font-weight: bold;">Phone:</td>
                    <td>${phone}</td>
                </tr>
                <tr>
                    <td style="font-weight: bold;">Preferred Contact:</td>
                    <td>${preferred_contact}</td>
                </tr>
            </table>

            <h3>Detailed Proposal Description</h3>
            <div style="background-color: #F8FAFC; border: 1px solid #E2E8F0; padding: 15px; border-radius: 4px; white-space: pre-wrap; font-family: sans-serif; line-height: 1.5;">
${description}
            </div>

            <p style="margin-top: 20px; font-size: 0.85em; color: #718096;">
                This email was auto-generated by the Tender Portal. The uploaded document is attached.
            </p>
        `;

        const mailTransporter = await getTransporter();
        const mailOptions = {
            from: `"${company} via Tender Portal" <${process.env.SMTP_USER || 'portal@apex-tenders.com'}>`,
            to: process.env.RECEIVER_EMAIL || 'procurement@apex-tenders.com',
            subject: `[TENDER SUBMISSION] ${title} - ${refCode}`,
            html: emailHTML,
            attachments: [
                {
                    filename: req.file.originalname,
                    content: req.file.buffer
                }
            ],
            replyTo: email
        };

        // Send email to procurement team
        const info = await mailTransporter.sendMail(mailOptions);
        console.log(`[Procurement Email Sent] Message ID: ${info.messageId}`);
        
        // If Ethereal test account, print preview URL in terminal
        if (nodemailer.getTestMessageUrl(info)) {
            console.log(`[Preview Procurement Email] URL: ${nodemailer.getTestMessageUrl(info)}`);
        }

        // Send confirmation receipt email to the applicant
        try {
            const confirmationHTML = `
                <h2>Tender Submission Confirmation</h2>
                <p>Dear ${fullname},</p>
                <p>Thank you for submitting your tender proposal. We have successfully received your proposal files and registered your submission.</p>
                
                <p><strong>Submission Summary:</strong></p>
                <table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; border-color: #E2E8F0; width: 100%; max-width: 600px;">
                    <tr>
                        <td style="width: 35%; font-weight: bold; background-color: #F8FAFC;">Reference Number:</td>
                        <td style="font-family: monospace; font-weight: bold; color: #0B1F3B;">${refCode}</td>
                    </tr>
                    <tr>
                        <td style="font-weight: bold; background-color: #F8FAFC;">Tender Title:</td>
                        <td>${title}</td>
                    </tr>
                    <tr>
                        <td style="font-weight: bold; background-color: #F8FAFC;">Category:</td>
                        <td>${category}</td>
                    </tr>
                    <tr>
                        <td style="font-weight: bold; background-color: #F8FAFC;">Deadline Date:</td>
                        <td>${deadline}</td>
                    </tr>
                    <tr>
                        <td style="font-weight: bold; background-color: #F8FAFC;">Uploaded Document:</td>
                        <td>${req.file.originalname}</td>
                    </tr>
                </table>

                <p style="margin-top: 20px;">
                    Our procurement review team will evaluate your proposal and get in touch with you using your preferred contact method (<strong>${preferred_contact}</strong>).
                </p>
                
                <br>
                <p>Best regards,<br><strong>Apex Procurement Services Ltd</strong></p>
            `;

            const confirmationOptions = {
                from: `"Apex Procurement Services" <${process.env.SMTP_USER || 'portal@apex-tenders.com'}>`,
                to: email,
                subject: `[Tender Submission] Confirmation Receipt - ${title} [${refCode}]`,
                html: confirmationHTML,
                attachments: [
                    {
                        filename: req.file.originalname,
                        content: req.file.buffer
                    }
                ]
            };

            const confirmationInfo = await mailTransporter.sendMail(confirmationOptions);
            console.log(`[Applicant Confirmation Email Sent] Message ID: ${confirmationInfo.messageId}`);
            if (nodemailer.getTestMessageUrl(confirmationInfo)) {
                console.log(`[Preview Confirmation Email] URL: ${nodemailer.getTestMessageUrl(confirmationInfo)}`);
            }
        } catch (confirmErr) {
            // Log but don't fail the primary transaction if the applicant's confirmation bounces
            console.error('Failed to send confirmation email to applicant:', confirmErr);
        }

        // Return successful response to frontend
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
