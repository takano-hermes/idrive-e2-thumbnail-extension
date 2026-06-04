/**
 * For S3 presigned URLs the payload hash MUST be UNSIGNED-PAYLOAD
 * DO NOT add X-Amz-Content-Sha256 to the query string
 * Uses path-style URLs for IDrive e2
 */
(function() {
  'use strict';

  async function getPresignedUrlS3Get(config) {
    const { accessKeyId, secretAccessKey, region, bucket, key, expiresIn = 604800 } = config;
    
    // Date formats
    const now = new Date();
    const yyyymmdd = now.toISOString().split('T')[0].replace(/-/g, '');
    const datetime = now.toISOString().replace(/[:\-]/g, '').split('.')[0] + 'Z';
    
    // Path-style URL components
    const host = `s3.${region}.idrivee2.com`;
    const encodedKey = key.split('/').map(s => encodeURIComponent(s)).join('/');
    const canonicalUri = '/' + bucket + '/' + encodedKey;
    
    // Build query parameters (sorted alphabetically - NO content-sha256)
    const credentialScope = `${yyyymmdd}/${region}/s3/aws4_request`;
    const encodedCredential = encodeURIComponent(accessKeyId + '/' + credentialScope);
    
    const qsParts = [
      `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
      `X-Amz-Credential=${encodedCredential}`,
      `X-Amz-Date=${datetime}`,
      `X-Amz-Expires=${expiresIn}`,
      `X-Amz-SignedHeaders=host`
    ];
    const canonicalQs = qsParts.join('&');
    
    // Canonical headers
    const canonicalHeaders = `host:${host}\n`;
    const signedHeaders = 'host';
    
    // CRITICAL: payload hash MUST be UNSIGNED-PAYLOAD for S3 presigned URLs
    // Do NOT add X-Amz-Content-Sha256 to query string
    const payloadHash = 'UNSIGNED-PAYLOAD';
    
    // Build canonical request
    const crParts = [
      'GET',
      canonicalUri,
      canonicalQs,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ];
    const canonicalRequest = crParts.join('\n');
    
    // DEBUG: log canonical request details
    console.log('[IDriveThumb:SigV4] CR lines:');
    crParts.forEach((p, i) => console.log('[IDriveThumb:SigV4]  ' + i + ':', JSON.stringify(p)));
    console.log('[IDriveThumb:SigV4] CR:', JSON.stringify(canonicalRequest));
    
    // Hash canonical request
    const encoder = new TextEncoder();
    const crHash = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest))
      .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''));
    
    // String to sign
    const stsParts = [
      'AWS4-HMAC-SHA256',
      datetime,
      credentialScope,
      crHash
    ];
    const stringToSign = stsParts.join('\n');
    
    // Derive signing key
    const encoder2 = new TextEncoder();
    const kDate = await hmacSha256(encoder2.encode('AWS4' + secretAccessKey), encoder2.encode(yyyymmdd));
    const kRegion = await hmacSha256(kDate, encoder2.encode(region));
    const kService = await hmacSha256(kRegion, encoder2.encode('s3'));
    const kSigning = await hmacSha256(kService, encoder2.encode('aws4_request'));
    
    // Calculate signature
    const signature = await hmacSha256(kSigning, encoder2.encode(stringToSign))
      .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''));
    
    // Build final URL (path-style)
    const url = `https://${host}${canonicalUri}?${canonicalQs}&X-Amz-Signature=${signature}`;
    return url;
  }

  async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, data);
  }

  window.E2C_S3 = {
    getPresignedUrl: getPresignedUrlS3Get
  };

})();
