#!/usr/bin/env python3
"""Minimal presigned URL server for IDrive e2 thumbnails"""
import json, sys
sys.path.insert(0, '/opt/hermes/.venv/lib/python3.13/site-packages')
import boto3
from botocore.config import Config
from http.server import HTTPServer, BaseHTTPRequestHandler

class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_cors(200)
    
    def send_cors(self, code):
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()
    
    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        params = parse_qs(urlparse(self.path).query)
        
        required = ['ak', 'sk', 'bucket', 'key']
        missing = [p for p in required if not params.get(p, [''])[0]]
        if missing:
            self.send_cors(400)
            self.wfile.write(json.dumps({'error': f'Missing: {missing}'}).encode())
            return
        
        try:
            client = boto3.client('s3',
                aws_access_key_id=params['ak'][0],
                aws_secret_access_key=params['sk'][0],
                region_name=params.get('region', ['ap-northeast-1'])[0],
                endpoint_url=f"https://s3.{params.get('region', ['ap-northeast-1'])[0]}.idrivee2.com",
                config=Config(signature_version='s3v4', retries={'max_attempts': 0})
            )
            url = client.generate_presigned_url(
                'get_object',
                Params={'Bucket': params['bucket'][0], 'Key': params['key'][0]},
                ExpiresIn=int(params.get('expires', ['604800'])[0])
            )
            self.send_cors(200)
            self.wfile.write(json.dumps({'url': url}).encode())
        except Exception as e:
            self.send_cors(500)
            self.wfile.write(json.dumps({'error': str(e)}).encode())

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9191
    server = HTTPServer(('0.0.0.0', port), Handler)
    print(f'Presign server on port {port}')
    server.serve_forever()
