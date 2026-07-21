import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";

const dbClient = new DynamoDBClient({ region: "ap-south-1" });
const docClient = DynamoDBDocumentClient.from(dbClient);
const s3Client = new S3Client({ region: "ap-south-1" });
const BUCKET_NAME = "secret-sharer-files-param-123";

export const handler = async (event) => {
    try {
        const body = JSON.parse(event.body || "{}");
        const encryptedSecret = body.secret; 
        const hasFile = body.hasFile === true; 
        const expireSeconds = parseInt(body.expireSeconds) || 86400;
        const maxViews = parseInt(body.maxViews) || 1;

        if (!encryptedSecret && !hasFile) return { statusCode: 400, body: JSON.stringify({ error: "Missing data" }) };

        const secretId = crypto.randomUUID();
        
        // 🚀 Saving to the new V2 Table created by Serverless!
        const vaultCommand = new PutCommand({
            TableName: "SecretSharer-v2",
            Item: {
                secretId: secretId,
                secretData: encryptedSecret || "NO_TEXT",
                hasFile: hasFile,
                maxViews: maxViews,
                expiresAt: Math.floor(Date.now() / 1000) + expireSeconds
            }
        });
        await docClient.send(vaultCommand);

        let uploadUrl = null;
        if (hasFile) {
            const s3Command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: secretId, ContentType: "application/octet-stream" });
            uploadUrl = await getSignedUrl(s3Client, s3Command, { expiresIn: 300 });
        }

        return { statusCode: 200, body: JSON.stringify({ id: secretId, uploadUrl: uploadUrl }) };
    } catch (error) {
        console.error(error);
        return { statusCode: 500, body: JSON.stringify({ error: "Server error" }) };
    }
};