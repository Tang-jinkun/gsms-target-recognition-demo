FROM mambaorg/micromamba:1.5.10

WORKDIR /workspace/backend

COPY --chown=$MAMBA_USER:$MAMBA_USER backend/environment.yml /tmp/environment.yml
RUN micromamba create -y -f /tmp/environment.yml && \
    micromamba clean --all --yes

COPY --chown=$MAMBA_USER:$MAMBA_USER backend /workspace/backend
COPY --chown=$MAMBA_USER:$MAMBA_USER sample_data /workspace/sample_data

EXPOSE 8000

CMD ["micromamba", "run", "-n", "gsms-invest", "python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
