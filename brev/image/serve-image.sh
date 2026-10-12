#!/usr/bin/env bash
# brev/image/serve-image.sh: runs ON the Brev box. Starts (or restarts) the SDXL-Turbo image service in Docker on 127.0.0.1:8001,
# next to vLLM on the same GPU (J483). Builds a small image on top of vllm/vllm-openai (torch is already there) the first time.
#   serve-image.sh          start it (stop: docker rm -f brev-image)
set -euo pipefail
W="$HOME/workspace"; D="$W/brev-image"
mkdir -p "$W/outputs" "$W/.cache/huggingface/hub" "$W/.cache/huggingface/xet"
BASE="${VLLM_IMAGE:-vllm/vllm-openai:latest}"  # the same base as vLLM (its torch must suit this box's GPU driver)
if [[ "$(docker image inspect -f '{{index .Config.Labels "brev.base"}}' brev-image:latest 2>/dev/null)" != "$BASE" ]]; then
  docker build -q -t brev-image:latest - >/dev/null <<EOF
FROM $BASE
RUN pip install -q "diffusers<0.36" accelerate "huggingface-hub==\$(python3 -c 'import huggingface_hub as h; print(h.__version__)')"
LABEL brev.base=$BASE
EOF
fi
docker rm -f brev-image >/dev/null 2>&1 || true
# runs as the box's user, so its images and cache files are yours (no root-owned files under ~/workspace)
docker run -d --name brev-image --gpus all --ipc=host -p 127.0.0.1:8001:8001 --user "$(id -u):$(id -g)" \
  -v "$W/.cache/huggingface:/hf" -e HF_HOME=/hf -e HOME=/tmp -v "$W/outputs:/outputs" -v "$D/server.py:/server.py:ro" \
  --entrypoint python3 brev-image:latest /server.py >/dev/null
for _ in $(seq 1 90); do curl -sf 127.0.0.1:8001/ >/dev/null && { echo "image service up (SDXL-Turbo) on 127.0.0.1:8001"; exit 0; }; docker ps --filter name=brev-image --format '{{.Status}}' | grep -q Up || { docker logs --tail 20 brev-image >&2; exit 1; }; sleep 2; done
echo "image service didn't answer within 3 min (docker logs brev-image)" >&2; exit 1
