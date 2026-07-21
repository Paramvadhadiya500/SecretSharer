import { S3Client, CreateMultipartUploadCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";

const s3Client = new S3Client({ region: "ap-south-1" });
const BUCKET_NAME = "secret-sharer-files-param-123";

export const handler = async (event) => {
    try {
        // 🛡️ Enterprise Base64 parsing shield
        let bodyString = event.body || "{}";
        if (event.isBase64Encoded) {
            bodyString = Buffer.from(event.body, 'base64').toString('utf8');
        }
        const body = JSON.parse(bodyString);
        
        const parts = body.parts || 1;
        const secretId = crypto.randomUUID();

        const createCmd = new CreateMultipartUploadCommand({ 
            Bucket: BUCKET_NAME, 
            Key: secretId, 
            ContentType: "application/octet-stream" 
        });
        const createRes = await s3Client.send(createCmd);
        const uploadId = createRes.UploadId;

        const presignedUrls = [];
        for (let i = 1; i <= parts; i++) {
            const partCmd = new UploadPartCommand({ Bucket: BUCKET_NAME, Key: secretId, UploadId: uploadId, PartNumber: i });
            const url = await getSignedUrl(s3Client, partCmd, { expiresIn: 3600 });
            presignedUrls.push(url);
        }

       const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
        };

        return { 
            statusCode: 200, 
            headers: corsHeaders, 
            body: JSON.stringify({ secretId, uploadId, presignedUrls }) 
        };
    } catch (error) {
        console.error(error);
        return { 
            statusCode: 500, 
            headers: { "Access-Control-Allow-Origin": "*" }, 
            body: JSON.stringify({ error: error.message || "Unknown error" }) 
        };
    }
};
