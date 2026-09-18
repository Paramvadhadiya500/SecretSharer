# 🛡️ DeadDrop - Secure Secret Sharer

DeadDrop is a highly secure, serverless application for sharing encrypted secrets and files. All cryptography is handled entirely in the browser using AES-GCM encryption, ensuring the server (AWS) never sees your raw data.

## 🚀 How to Run the Project

### 1. Web Application (Frontend)
The web application is a static HTML file that runs entirely in your browser.
1. Navigate to the project root directory.
2. Serve the directory using `npx serve .` (or any local web server).
3. Open `http://localhost:3000` in your web browser.

### 2. Command Line Interface (CLI)
You can securely generate and push secrets straight from your terminal!
1. Navigate to the CLI directory: `cd deaddrop-cli`
2. Run the CLI tool:
   ```bash
   node deaddrop.js <your_password> "<your_secret_message>"
   ```
   *Example: `node deaddrop.js Password123 "Deploy keys inside!"`*

## ☁️ Backend Architecture
This project utilizes an AWS Serverless V2 architecture deployed via the Serverless Framework.
- **AWS API Gateway:** Handles routing and endpoints (`/v2/initiate`, `/v2/complete`, `/v2/read`).
- **AWS Lambda:** Serverless compute for processing requests.
- **Amazon DynamoDB:** Stores the encrypted secret metadata and configurations (TTL, view limits, alerts).
- **Amazon S3:** Vault for securely storing encrypted file attachments via pre-signed URLs.
- **Amazon SNS:** Email engine that fires "Burn Receipts" when a payload is read and destroyed.

To deploy changes to the backend:
```bash
cd deaddrop-iac
npm install
npx serverless@3 deploy
```
