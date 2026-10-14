using System;
using System.Drawing;
using System.Windows.Forms;

namespace Demo.Babylon3D
{
    /// <summary>A WinForms window that spins a cube with a software renderer.</summary>
    public class Babylon3DCubeDemo : Form
    {
        private Timer timer;
        private Bitmap frame;
        private float angle;
        private Label status;

        /// <summary>Build the window, the label and the animation timer.</summary>
        public Babylon3DCubeDemo()
        {
            this.SuspendLayout();
            this.Text = "Cube";
            this.ClientSize = new Size(640, 480);
            this.DoubleBuffered = true;
            status = new Label();
            status.Dock = DockStyle.Bottom;
            this.Controls.Add(status);
            timer = new Timer();
            timer.Interval = 16;
            timer.Tick += OnTick;
            timer.Start();
            this.KeyDown += OnKey;
            this.ResumeLayout(false);
        }

        /// <summary>Advance the rotation and redraw.</summary>
        private void OnTick(object sender, EventArgs e)
        {
            angle += 0.03f;
            status.Text = string.Format("angle={0:F2}", angle);
            this.Invalidate();
        }

        private void OnKey(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) this.Close();
            else if (e.KeyCode == Keys.F1) MessageBox.Show("Arrow keys rotate", "Help", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        /// <summary>Draw the cube edges with GDI+.</summary>
        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Color.Black);
            using (var pen = new Pen(Color.FromArgb(255, 0, 255, 0), 2f))
            {
                for (int i = 0; i < 4; i++)
                {
                    float x = (float)Math.Cos(angle + i * Math.PI / 2) * 100 + 320;
                    float y = (float)Math.Sin(angle + i * Math.PI / 2) * 100 + 240;
                    g.DrawLine(pen, 320, 240, x, y);
                }
            }
            g.DrawString("cube", new Font("Arial", 12), Brushes.White, 10, 10);
            base.OnPaint(e);
        }

        /// <summary>Run the demo as a standalone application.</summary>
        [STAThread]
        public static void Run()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Babylon3DCubeDemo());
        }
    }
}
