"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaserowPlus = void 0;

/**
 * Credentials definition for the Baserow Plus node.
 *
 * Stores the base URL and API token for a Baserow instance.
 * Uses a distinct credential name (baserowPlusApi) to avoid conflicts
 * if both v2 and v3 are installed side-by-side.
 *
 * @see https://baserow.io/docs/apis%2Frest-api
 */
class BaserowPlus {
    constructor() {
        this.name = 'baserowPlusApi';
        this.displayName = 'Baserow Plus API';
        this.documentationUrl = 'https://baserow.io/docs/apis%2Frest-api';
        this.properties = [
            {
                displayName: 'Base URL',
                name: 'baseUrl',
                type: 'string',
                default: 'https://api.baserow.io',
                required: true,
                description: 'The root URL of your Baserow instance (e.g. "https://api.baserow.io" for Baserow Cloud, or your self-hosted URL such as "https://baserow.example.com").',
            },
            {
                displayName: 'API Token',
                name: 'apiToken',
                type: 'string',
                typeOptions: {
                    password: true,
                },
                default: '',
                required: true,
                description: 'Your Baserow API token. Generate one in Baserow under Settings → API Tokens.',
            },
        ];
    }
}

exports.BaserowPlus = BaserowPlus;
