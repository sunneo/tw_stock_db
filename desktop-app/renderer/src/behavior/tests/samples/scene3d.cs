using System;
using System.Numerics;
using SDL2;

namespace Demo.Babylon3D
{
    /// <summary>A small 3D scene: owns the SDL window, GL context and the camera.</summary>
    public class Babylon3DScene : IDisposable
    {
        private IntPtr window, glContext;
        private Matrix4x4 view, proj;
        private uint vbo, vao;

        /// <summary>Create the window and the OpenGL context.</summary>
        public void Init(int w, int h)
        {
            if (SDL.SDL_Init(SDL.SDL_INIT_VIDEO) < 0) throw new Exception(SDL.SDL_GetError());
            window = SDL.SDL_CreateWindow("scene", 0, 0, w, h, SDL.SDL_WindowFlags.SDL_WINDOW_OPENGL);
            glContext = SDL.SDL_GL_CreateContext(window);
            GL.Enable(EnableCap.DepthTest);
            vao = GL.GenVertexArray();
            GL.BindVertexArray(vao);
            vbo = GL.GenBuffer();
            GL.BindBuffer(BufferTarget.ArrayBuffer, vbo);
        }

        /// <summary>Update the camera matrices.</summary>
        public void UpdateCamera(Vector3 eye, Vector3 target)
        {
            view = Matrix4x4.CreateLookAt(eye, target, Vector3.UnitY);
            proj = Matrix4x4.CreatePerspectiveFieldOfView(MathF.PI / 3, 16f / 9f, 0.1f, 100f);
        }

        /// <summary>Draw one frame and handle input events.</summary>
        public bool Frame()
        {
            SDL.SDL_Event e;
            while (SDL.SDL_PollEvent(out e) != 0)
            {
                if (e.type == SDL.SDL_EventType.SDL_QUIT) return false;
            }
            GL.Clear(ClearBufferMask.ColorBufferBit | ClearBufferMask.DepthBufferBit);
            GL.DrawArrays(PrimitiveType.Triangles, 0, 36);
            SDL.SDL_GL_SwapWindow(window);
            return true;
        }

        public void Dispose()
        {
            GL.DeleteBuffer(vbo);
            SDL.SDL_GL_DeleteContext(glContext);
            SDL.SDL_DestroyWindow(window);
            SDL.SDL_Quit();
        }
    }
}
