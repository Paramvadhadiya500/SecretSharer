const AWS = require("aws-sdk");
const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const TABLE_NAME = "SecretSharer-v2";
const BUCKET_NAME = "secretsharer-1-param";

exports.handler = async (event) => {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
        "Access-Control-Allow-Headers": "Content-Type"
    };

    try {
        const body = JSON.parse(event.body);
        const finalId = body.id || body.secretId || `web-${Date.now()}`;

        let uploadUrl = null;

        // 🎯 THE FIX: Generate a simple S3 Pre-signed URL for the V1 Frontend
        if (body.hasFile) {
            uploadUrl = s3.getSignedUrl('putObject', {
                Bucket: BUCKET_NAME,
                Key: `uploads/${finalId}`,
                Expires: 3600,
                ContentType: 'application/octet-stream'
            });
        }

        const item = {
            secretId: finalId,
            secretData: body.secretData || body.secret || " ",
            hasFile: body.hasFile || false,
            userEmail: body.userEmail || "anonymous",
            viewsRemaining: body.maxViews ? parseInt(body.maxViews) : 1,
            wantsAlert: body.sendAlert || body.wantsAlert || false,
            createdAt: new Date().toISOString()
         
        };

        if (body.expireSeconds) {
            item.ttl = Math.floor(Date.now() / 1000) + parseInt(body.expireSeconds);
        }

        await docClient.put({ TableName: TABLE_NAME, Item: item }).promise();

        // Pass the uploadUrl back so your frontend file upload actually works!
        return { 
            statusCode: 200, 
            headers: corsHeaders, 
            body: JSON.stringify({ id: finalId, uploadUrl: uploadUrl }) 
        };

    } catch (error) {
        console.log("LAMBDA ERROR:", error);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: error.message }) };
    }
};