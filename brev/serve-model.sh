#!/usr/bin/env bash
# brev/serve-model.sh: runs ON the Brev GPU box. Serves one Hugging Face model with vLLM (Docker) on 127.0.0.1:8000 and adds it
# to pi's ~/.pi/agent/models.json as provider "local-vllm" (J476). The HF cache stays under ~/workspace, which survives a stop.
#   serve-model.sh <hf model id> [extra vllm args...]   replace the running model (a T4 holds one small model at a time)
#   serve-model.sh                                       restart the last model (after `brev start`)
#   serve-model.sh stop                                  stop the server (the GPU's memory is freed)
# Copy it there: scp brev/serve-model.sh hyprpi-gpu:workspace/  (gated models need HF_TOKEN in the environment)
set -euo pipefail
W="$HOME/workspace"; LAST="$W/.serve-model.last"; IMAGE="${VLLM_IMAGE:-vllm/vllm-openai:latest}"
if [[ "${1:-}" == stop ]]; then docker rm -f vllm >/dev/null 2>&1 || true; echo "vllm stopped"; exit 0; fi
if [[ $# -eq 0 ]]; then [[ -f "$LAST" ]] || { echo "usage: serve-model.sh <hf model id> [vllm args]" >&2; exit 2; }; mapfile -t args < "$LAST"; else args=("$@"); fi
MODEL="${args[0]}"; printf '%s\n' "${args[@]}" > "$LAST"
mkdir -p "$W/.cache/huggingface"
# compute capability below 8 (T4) has no bfloat16: half precision there
cap=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1); dtype=auto; [[ "${cap%%.*}" -ge 8 ]] || dtype=half
docker rm -f vllm >/dev/null 2>&1 || true
# no --restart: the server comes back only when asked (a stopped box shouldn't wake up into a half-set-up state)
docker run -d --name vllm --gpus all --ipc=host -p 127.0.0.1:8000:8000 \
  -v "$W/.cache/huggingface:/root/.cache/huggingface" -e HF_HOME=/root/.cache/huggingface ${HF_TOKEN:+-e HF_TOKEN} \
  "$IMAGE" "$MODEL" --dtype "$dtype" --max-model-len "${MAX_LEN:-32768}" --gpu-memory-utilization 0.9 \
  --enable-auto-tool-choice --tool-call-parser "${TOOL_PARSER:-hermes}" "${args[@]:1}" >/dev/null
echo "starting $MODEL (dtype $dtype); waiting for http://127.0.0.1:8000 ..."
for _ in $(seq 1 120); do
  curl -sf 127.0.0.1:8000/v1/models >/dev/null && break
  docker ps --filter name=vllm --format '{{.Status}}' | grep -q Up || { docker logs --tail 30 vllm >&2; exit 1; }
  sleep 5
done
curl -sf 127.0.0.1:8000/v1/models >/dev/null || { echo "vllm didn't answer within 10 min (docker logs -f vllm)" >&2; exit 1; }
# pi: the served model under provider local-vllm (files 600, folder 700: hyprpi's remote.sh refuses anything looser)
M="$HOME/.pi/agent/models.json"; mkdir -p "$(dirname "$M")"; chmod 700 "$(dirname "$M")"; [[ -f "$M" ]] || echo '{"providers":{}}' > "$M"
node -e '
const fs=require("fs"),[f,id,ctx]=process.argv.slice(1); const j=JSON.parse(fs.readFileSync(f,"utf8")); j.providers??={};
const p=j.providers["local-vllm"]??={baseUrl:"http://127.0.0.1:8000/v1",api:"openai-completions",apiKey:"local",models:[]};
if(!p.models.some(m=>m.id===id)) p.models.push({id,name:`${id} (local vLLM)`,contextWindow:+ctx,maxTokens:4096});
fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$M" "$MODEL" "${MAX_LEN:-32768}"
chmod 600 "$M"
echo "serving $MODEL on 127.0.0.1:8000; in pi: /model, then local-vllm/$MODEL"
