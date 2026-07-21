const crypto = require('crypto');
const fs = require('fs');

const API_URL = "https://kakhkdaxj2.execute-api.ap-south-1.amazonaws.com/dev/v2/complete";
const FRONTEND_URL = "http://localhost:3000"; 

async function runCLI() {
    console.log("🛡️  DeadDrop Enterprise CLI Initiated...\n");

    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log("Usage: node deaddrop.js <password> <secret_message>");
        console.log("Example: node deaddrop.js myPass123 'Server passwords inside'");
        process.exit(1);
    }

    const password = args[0];
    const text = args.slice(1).join(" ");

    try {
        console.log("[SYS] Generating Cryptographic Keys...");
        const salt = crypto.randomBytes(16);
        const iv = crypto.randomBytes(12);
        
        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

        console.log("[CRYPTO] Executing AES-256-GCM Encryption...");
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        
        const metadata = JSON.stringify({ text, fileName: null, fileType: null });
        let encryptedMeta = cipher.update(metadata, 'utf8');
        encryptedMeta = Buffer.concat([encryptedMeta, cipher.final()]);
        const authTag = cipher.getAuthTag();

        const combinedMeta = Buffer.concat([salt, iv, encryptedMeta, authTag]);
        const finalMetaBlob = combinedMeta.toString('base64');

        const generatedId = "cli-" + crypto.randomBytes(8).toString('hex');

        console.log("[AWS] Committing atomic record to DynamoDB...");
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: generatedId,       
                secretId: generatedId, 
                secretData: finalMetaBlob,
                hasFile: false,
                maxViews: 1, 
                expireSeconds: 86400 
            })
        });

       if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`AWS Error ${response.status}: ${errBody}`);
        }
        
        const result = await response.json(); 

        console.log("\n✅ Vault Locked Successfully!");
        console.log("🔗 Share Link:", `${FRONTEND_URL}?id=${result.id || result.secretId || generatedId}`);
        console.log("🔑 Password:", password);
        console.log("\n(Send the link and password to your employees separately)");

    } catch (error) {
        console.error("\n❌ CLI Error:", error.message);
    }
}

runCLI();