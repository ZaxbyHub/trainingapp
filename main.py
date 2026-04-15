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
import logging


def create_parser():
    """Create and return the argument parser."""
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

    return parser


def main():
    # Set up file logging for PyInstaller frozen mode (console=False swallows stdout)
    log_dir = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Document Q&A Assistant")
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, "app.log")
    logging.basicConfig(
        filename=log_file,
        level=logging.DEBUG,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        filemode="w",  # Overwrite on each launch for fresh logs
        force=True,
    )
    logging.getLogger(__name__).info("Application starting")

    args = create_parser().parse_args()

    # Set environment variables from args
    if args.db_path:
        os.environ["RAG_DB_PATH"] = args.db_path
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
        except Exception as e:
            logging.getLogger(__name__).critical("Unhandled exception during GUI launch", exc_info=True)
            sys.exit(1)


if __name__ == "__main__":
    main()
