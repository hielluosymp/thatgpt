from flask import Flask, render_template, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import cohere
import os
import json
import firebase_admin
from firebase_admin import credentials

if not firebase_admin._apps:
    _sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    cred = credentials.Certificate(json.loads(_sa) if _sa else "serviceAccountKey.json")
    firebase_admin.initialize_app(cred)

from firebase_admin import auth as fb_auth

app = Flask(__name__)
CORS(app)

cohere_client = cohere.ClientV2(api_key=os.environ.get("COHERE_API_KEY"))


@app.route('/')
def index():
    return render_template("index.html")

@app.route('/auth/custom-token', methods=['POST'])
def custom_token():
    id_token = request.json.get('idToken')
    if not id_token:
        return jsonify({'error': 'Missing idToken'}), 400
    try:
        decoded = fb_auth.verify_id_token(id_token)
        custom = fb_auth.create_custom_token(decoded['uid'])
        return jsonify({'customToken': custom.decode('utf-8')})
    except Exception as e:
        return jsonify({'error': str(e)}), 401


@app.route('/about')
def about():
    return render_template("about.html")


@app.route('/get_response', methods=['POST'])
def get_response():
    data = request.json
    if not data or not data.get("message", "").strip():
        return jsonify({"error": "Message is required"}), 400

    user_message = data["message"].strip()
    history = data.get("history", [])

    messages = [{"role": "system", "content": "You are a helpful assistant. Be clear and direct. Do not cite sources or add references."}]
    for msg in history[:-1]:
        role = "user" if msg["role"] == "user" else "assistant"
        messages.append({"role": role, "content": msg["content"]})
    messages.append({"role": "user", "content": user_message})

    def generate():
        try:
            stream = cohere_client.chat_stream(
                model="command-r-08-2024",
                messages=messages
            )
            for event in stream:
                    try:
                        if (event.type == "content-delta"
                                and event.delta
                                and event.delta.message
                                and event.delta.message.content
                                and event.delta.message.content.text):
                            yield f"data: {json.dumps({'chunk': event.delta.message.content.text})}\n\n"
                    except AttributeError:
                        pass
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(
        stream_with_context(generate()),
        content_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'}
    )


@app.route('/get_title', methods=['POST'])
def get_title():
    data = request.json
    message = data.get("message", "").strip()
    title = message[:40] + ('…' if len(message) > 40 else '')
    return jsonify({"title": title})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
