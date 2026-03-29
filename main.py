#!/usr/bin/env python3
"""
Document Q&A Assistant
Main entry point for the application.

Usage:
    python main.py              # Launch GUI
    python main.py --api        # Run API server
    python main.py --cli        # Interactive CLI mode
    python main.py --ingest DIR # Ingest documents from directory
"""

import os
import sys
import argparse


def main():
    parser = argparse.ArgumentParser(
        description="Document Q&A Assistant - RAG-based document question answering"
    )

    parser.add_argument("--api", action="store_true", help="Run as API server")
    parser.add_argument(
        "--cli", action="store_true", help="Run in interactive CLI mode"
    )
    parser.add_argument(
        "--ingest", type=str, metavar="DIR", help="Ingest documents from directory"
    )
    parser.add_argument("--query", type=str, help="Ask a single question and exit")

    # Configuration options
    parser.add_argument(
        "--db-path", type=str, default="./doc_qa_db", help="Path to vector database"
    )
    parser.add_argument(
        "--model-path",
        type=str,
        help="Path to GGUF model file (legacy alias for --gguf-path)",
    )
    parser.add_argument(
        "--ollama-url",
        type=str,
        default="http://localhost:11434",
        help="Ollama server URL",
    )
    parser.add_argument(
        "--ollama-model", type=str, default="phi3:mini", help="Ollama model name"
    )
    parser.add_argument("--api-url", type=str, help="OpenAI-compatible API URL")
    parser.add_argument("--gguf-path", type=str, help="Path to GGUF model file")
    parser.add_argument("--port", type=int, default=8080, help="API server port")
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=512,
        help="Document chunk size in words (default: 512)",
    )
    parser.add_argument(
        "--chunk-overlap",
        type=int,
        default=50,
        help="Chunk overlap in words (default: 50)",
    )

    args = parser.parse_args()

    # Set environment variables from args
    if args.db_path:
        os.environ["RAG_DB_PATH"] = args.db_path
    if args.model_path:
        os.environ["RAG_MODEL_PATH"] = args.model_path
    if args.ollama_url:
        os.environ["RAG_OLLAMA_URL"] = args.ollama_url
    if args.ollama_model:
        os.environ["RAG_OLLAMA_MODEL"] = args.ollama_model
    if args.api_url:
        os.environ["RAG_API_URL"] = args.api_url
    if args.gguf_path:
        os.environ["RAG_GGUF_PATH"] = args.gguf_path
    os.environ["API_PORT"] = str(args.port)

    if args.api:
        # Run API server
        from api_server import main as run_api

        run_api()

    elif args.cli or args.ingest or args.query:
        # CLI mode - use engine_factory for consistent initialization
        from engine_factory import create_engine_from_env
        
        engine = create_engine_from_env()

        if args.ingest:
            print(f"\nIngesting documents from: {args.ingest}")
            stats = engine.ingest_directory(args.ingest)
            print(f"\nResult: {stats}")

        if args.query:
            result = engine.query(args.query)
            print(f"\nQuestion: {result.question}")
            print(f"Answer: {result.answer}")
            print(f"Sources: {result.sources}")
            print(f"Time: {result.inference_time:.2f}s")

        elif args.cli:
            print("\nInteractive mode (type 'quit' to exit)")
            print("-" * 40)

            while True:
                try:
                    question = input("\nYou: ").strip()
                    if question.lower() in ["quit", "exit", "q"]:
                        break
                    if not question:
                        continue

                    result = engine.query(question)
                    print(f"\nAssistant: {result.answer}")
                    if result.sources:
                        print(f"(Sources: {', '.join(result.sources)})")

                except KeyboardInterrupt:
                    break

            print("\nGoodbye!")

    else:
        # Default: Launch GUI
        try:
            from app_gui import main as run_gui

            run_gui()
        except ImportError as e:
            print(f"GUI not available: {e}")
            print("Install with: pip install customtkinter")
            print("\nUse --cli for command line mode or --api for server mode")
            sys.exit(1)


if __name__ == "__main__":
    main()
