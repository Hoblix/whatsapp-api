export interface Env {
  NODE_ENV: string;
  PORT?: string;
  DATABASE_URL: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  CORS_ORIGIN?: string;
  AWS_REGION_NAME?: string;
  DYNAMODB_TABLE?: string;
  WS_API_ENDPOINT?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_BUSINESS_ACCOUNT_ID?: string;
  WHATSAPP_WEBHOOK_VERIFY_TOKEN?: string;
}
