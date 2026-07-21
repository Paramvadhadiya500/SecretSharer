const AWS = require("aws-sdk");
const docClient = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = "SecretSharer-v2";

exports.handler = async (event) => {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
        "Access-Control-Allow-Headers": "Content-Type"
    };

    try {
        const body = JSON.parse(event.body);
        const userEmail = body.userEmail;

        if (!userEmail) {
            return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Missing userEmail" }) };
        }

        // Scan the table for records matching this user's email
        const data = await docClient.scan({
            TableName: TABLE_NAME,
            FilterExpression: "userEmail = :email",
            ExpressionAttributeValues: { ":email": userEmail }
        }).promise();

        const logs = data.Items.map(item => ({
            secretId: item.secretId,
            status: "🟢 Active", 
            createdAt: item.createdAt
        }));

        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ logs }) };

    } catch (error) {
        console.log("DASHBOARD ERROR:", error);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: error.message }) };
    }
};