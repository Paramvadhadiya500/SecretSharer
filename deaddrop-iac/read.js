const AWS = require("aws-sdk");
const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const sns = new AWS.SNS(); // 👈 NEW: Bring in the SNS Engine

const TABLE_NAME = "SecretSharer-v2";
const BUCKET_NAME = "secretsharer-1-param";

exports.handler = async (event) => {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
        "Access-Control-Allow-Headers": "Content-Type"
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    try {
        let body = {};
        if (event.body) {
            body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        }
        
        const id = body.id || body.secretId || (event.queryStringParameters && event.queryStringParameters.id);

        if (!id) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Missing ID in Payload" }) };

        // 1. Fetch the secret
        const getParams = { TableName: TABLE_NAME, Key: { secretId: id } };
        const result = await docClient.get(getParams).promise();
        const secretItem = result.Item;

        if (!secretItem) return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: "Not found or expired" }) };

        // 2. Atomic Locking & Views Countdown
        let isDestroyed = false;
        let remainingViews = secretItem.viewsRemaining || 1;

        if (remainingViews === 1) {
            // Destroy the record
            await docClient.delete({
                TableName: TABLE_NAME,
                Key: { secretId: id },
                ConditionExpression: "viewsRemaining = :expected",
                ExpressionAttributeValues: { ":expected": 1 }
            }).promise();
            isDestroyed = true;
            remainingViews = 0;

            // 🎯 THE SNS BURN RECEIPT: Fire the email!
            if (secretItem.wantsAlert && process.env.SNS_TOPIC_ARN) {
                try {
                    await sns.publish({
                        TopicArn: process.env.SNS_TOPIC_ARN,
                        Subject: "🚨 DeadDrop Protocol: Payload Terminated",
                        Message: `ATTENTION:\n\nThe secure payload [ID: ${id}] was just decrypted by a recipient.\n\nThe data has been permanently wiped from the AWS S3 Vault and DynamoDB. Zero traces remain.\n\nTimestamp: ${new Date().toISOString()}`
                    }).promise();
                    console.log("SNS Audit Alert fired successfully.");
                } catch (snsError) {
                    console.error("SNS Error:", snsError);
                    // We catch the error so if the email fails, the user still gets their file!
                }
            }

        } else if (remainingViews > 1) {
            const updateRes = await docClient.update({
                TableName: TABLE_NAME,
                Key: { secretId: id },
                UpdateExpression: "SET viewsRemaining = viewsRemaining - :dec",
                ConditionExpression: "viewsRemaining > :min",
                ExpressionAttributeValues: { ":dec": 1, ":min": 1 },
                ReturnValues: "UPDATED_NEW"
            }).promise();
            remainingViews = updateRes.Attributes.viewsRemaining;
        }

        // 3. Generate S3 Download URL
        let downloadUrl = null;
        if (secretItem.hasFile) {
            downloadUrl = s3.getSignedUrl('getObject', { Bucket: BUCKET_NAME, Key: `uploads/${id}`, Expires: 3600 });
        }

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                message: isDestroyed ? "Record permanently destroyed." : `Record viewed. ${remainingViews} views remaining.`,
                secretData: secretItem.secretData,
                downloadUrl: downloadUrl
            })
        };

    } catch (error) {
        console.error(error);
        if (error.code === 'ConditionalCheckFailedException') {
            return { statusCode: 409, headers: corsHeaders, body: JSON.stringify({ error: "Conflict" }) };
        }
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Internal server error" }) };
    }
};