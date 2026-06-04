FROM mambaorg/micromamba:1.5.10

WORKDIR /workspace/backend

COPY --chown=$MAMBA_USER:$MAMBA_USER backend/environment.yml /tmp/environment.yml
RUN printf '%s\n' \
    'show_channel_urls: true' \
    'default_channels:' \
    '  - https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main' \
    '  - https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/r' \
    'custom_channels:' \
    '  conda-forge: https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud' \
    '  bioconda: https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud' \
    '  msys2: https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud' \
    > /home/$MAMBA_USER/.condarc
RUN micromamba create -y -f /tmp/environment.yml && \
    micromamba clean --all --yes

COPY --chown=$MAMBA_USER:$MAMBA_USER backend /workspace/backend
COPY --chown=$MAMBA_USER:$MAMBA_USER sample_data /workspace/sample_data

EXPOSE 8000

USER root

CMD ["micromamba", "run", "-n", "gsms-invest", "bash", "-lc", "alembic upgrade head && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"]
